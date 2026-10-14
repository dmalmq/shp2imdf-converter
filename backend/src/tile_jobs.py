"""Vector tile builds for the colour tool: one at a time, in the background, from a converted upload on disk.

A build takes minutes and the one ArcGIS Pro licence, so builds wait in one
line and a single thread runs ``build_tiles.py`` for each in turn. A job is
queued, then running (step n of 5), then done or failed; nothing else. The
converted archive is written to the job's folder and unpacked beside it, so
the project's relative paths still find its data, and the download is that
archive's entries unchanged plus ``vector_tiles/<name>.vtiles/...`` and the
build log, written to disk once and streamed from there.

Jobs live in memory and their folders under one root. A restart loses them:
the root is emptied at startup and an unknown id is simply not found.
Finished jobs are deleted ``ttl_seconds`` after they finish.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Iterator, Sequence
from dataclasses import asdict, dataclass, field
from datetime import timedelta
import json
import logging
from pathlib import Path
import secrets
import shutil
import subprocess
import threading
import time
from typing import IO, Annotated, Literal
import zipfile

from pydantic import BaseModel, Field

from backend.src.recolor import Archive
from backend.src.tile_layers import LayerVisibility

logger = logging.getLogger(__name__)

WORKER = Path(__file__).with_name("build_tiles.py")
TIMEOUT_SECONDS = 2 * 60 * 60
STEPS = 5
TILES_FOLDER = "vector_tiles"
_LOG_NAME = "build_log.txt"
_LAYERS_NAME = "layers.json"


class Queued(BaseModel):
    state: Literal["queued"] = "queued"
    position: int
    """1 for the next job to start."""


class Running(BaseModel):
    state: Literal["running"] = "running"
    step: int
    """0 while the project opens and its data sources are checked, then 1 to ``of``."""
    of: int
    label: str


class Done(BaseModel):
    state: Literal["done"] = "done"
    filename: str
    warnings: list[str]
    problems: list[str]
    """What the checks found wrong with the tiles. They are in the download all the same."""


class Failed(BaseModel):
    state: Literal["failed"] = "failed"
    reason: str


JobStatus = Annotated[Queued | Running | Done | Failed, Field(discriminator="state")]


@dataclass(slots=True)
class _Waiting:
    """In line; the position is read off the line, never stored."""


@dataclass(slots=True)
class _Job:
    id: str
    directory: Path
    filename: str
    project: str
    """The ``.aprx``'s path inside the converted archive."""
    state: _Waiting | Running | Done | Failed = field(default_factory=_Waiting)
    finished: float | None = None


class TileJobs:
    def __init__(
        self, root: Path, *, ttl_seconds: float, script: Path = WORKER, timeout_seconds: float = TIMEOUT_SECONDS
    ) -> None:
        self.root = root
        self.script = script
        self.ttl_seconds = ttl_seconds
        self.timeout_seconds = timeout_seconds
        self._jobs: dict[str, _Job] = {}
        self._line: deque[tuple[str, Path]] = deque()
        self._changed = threading.Condition()
        self._runner: threading.Thread | None = None
        # Whatever is here belonged to a server that is gone; its ids can never be asked for again.
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)

    def submit(self, archive: Archive, project: str, python: Path, layers: Sequence[LayerVisibility]) -> str:
        """Unpack ``archive`` into a new job folder and put the job in line. Returns its id.

        ``layers`` is the visibility the worker sets on every layer and group of the map before tiling.
        """
        job_id = secrets.token_hex(6)
        directory = self.root / job_id
        directory.mkdir()
        converted = directory / "converted.zip"
        converted.write_bytes(archive.data)
        (directory / _LAYERS_NAME).write_text(
            json.dumps({"layers": [asdict(line) for line in layers]}, ensure_ascii=False), encoding="utf-8"
        )
        with zipfile.ZipFile(converted) as unpacked:
            unpacked.extractall(directory / "tree")
        job = _Job(id=job_id, directory=directory, filename=archive.filename, project=project)
        with self._changed:
            self._jobs[job_id] = job
            self._line.append((job_id, python))
            if self._runner is None:
                self._runner = threading.Thread(target=self._run, name="tile-builds", daemon=True)
                self._runner.start()
            self._changed.notify()
        return job_id

    def status(self, job_id: str) -> Queued | Running | Done | Failed | None:
        with self._changed:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if isinstance(job.state, _Waiting):
                return Queued(position=1 + [waiting for waiting, _ in self._line].index(job_id))
            return job.state

    def download(self, job_id: str) -> Path | None:
        """The finished zip, or None unless the job is done."""
        with self._changed:
            job = self._jobs.get(job_id)
            return job.directory / "download.zip" if job and isinstance(job.state, Done) else None

    def prune(self) -> None:
        """Delete jobs that finished more than ``ttl_seconds`` ago."""
        cutoff = time.time() - self.ttl_seconds
        with self._changed:
            expired = [job for job in self._jobs.values() if job.finished is not None and job.finished <= cutoff]
            for job in expired:
                del self._jobs[job.id]
        for job in expired:
            shutil.rmtree(job.directory, ignore_errors=True)
        if expired:
            logger.info("Removed %d finished vector tile builds", len(expired))

    def _set(self, job: _Job, state: Running | Done | Failed) -> None:
        with self._changed:
            job.state = state
            if not isinstance(state, Running):
                job.finished = time.time()

    def _run(self) -> None:
        while True:
            with self._changed:
                while not self._line:
                    self._changed.wait()
                # Only finished jobs are pruned, so one in line is always there.
                job_id, python = self._line.popleft()
                job = self._jobs[job_id]
                job.state = Running(step=0, of=STEPS, label="Opening the project")
            try:
                outcome: Done | Failed = _Build(self, job, python).run()
            except Exception as exc:
                logger.exception("Vector tile build %s failed", job.id)
                outcome = Failed(reason=f"The server could not finish the build: {exc}")
            # Only the download and the log are read from here on; a station's tree can run to a gigabyte.
            for scratch in ("tree", "out"):
                shutil.rmtree(job.directory / scratch, ignore_errors=True)
            (job.directory / "converted.zip").unlink(missing_ok=True)
            (job.directory / _LAYERS_NAME).unlink(missing_ok=True)
            self._set(job, outcome)


class _Build:
    """One run of the worker: its stdout parsed line by line into progress, its stderr kept for the log."""

    def __init__(self, jobs: TileJobs, job: _Job, python: Path) -> None:
        self.jobs = jobs
        self.job = job
        self.python = python
        self.log: list[str] = []
        self.warnings: list[str] = []
        self.result: dict | None = None
        self.reason: str | None = None

    def run(self) -> Done | Failed:
        tree = self.job.directory / "tree"
        out = self.job.directory / "out"
        layers = self.job.directory / _LAYERS_NAME
        command = [str(self.python), "-I", str(self.jobs.script), str(tree / self.job.project), str(tree), str(out), str(layers)]
        self.log.append(f"Project: {self.job.project}")
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        stderr: list[str] = []
        reader = threading.Thread(target=lambda: stderr.extend(_lines(process.stderr)), daemon=True)
        reader.start()
        timer = threading.Timer(self.jobs.timeout_seconds, process.kill)
        timer.start()
        try:
            for line in _lines(process.stdout):
                self._take(line)
            returncode = process.wait()
        finally:
            timed_out = not timer.is_alive() and process.returncode != 0
            timer.cancel()
            reader.join()
        self.log += [f"stderr: {line}" for line in stderr]
        outcome = self._outcome(returncode, stderr, timed_out, out)
        if isinstance(outcome, Failed):
            self.log.append(f"FAILED: {outcome.reason}")
        self._log_file().write_text("\r\n".join(self.log) + "\r\n", encoding="utf-8", newline="")
        if isinstance(outcome, Done):
            self._write_download(Path(self.result["vtiles"]))
        return outcome

    def _log_file(self) -> Path:
        return self.job.directory / _LOG_NAME

    def _take(self, line: str) -> None:
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        if not isinstance(event, dict):
            self.log.append(line)
            return
        kind = event.get("event")
        if kind == "step":
            running = Running(step=event["step"], of=event["of"], label=event["label"])
            self.jobs._set(self.job, running)
            self.log.append(f"[{running.step}/{running.of}] {running.label}")
        elif kind == "warning":
            self.warnings.append(event["text"])
            self.log.append(f"WARNING: {event['text']}")
        elif kind == "message":
            self.log.append(event["text"])
        elif kind == "result":
            self.result = event
        elif kind == "failed":
            self.reason = event["reason"]
        else:
            self.log.append(line)

    def _outcome(self, returncode: int, stderr: list[str], timed_out: bool, out: Path) -> Done | Failed:
        if timed_out:
            limit = timedelta(seconds=round(self.jobs.timeout_seconds))
            return Failed(reason=f"The build was stopped after running for {limit} (h:mm:ss).")
        if returncode != 0 or self.result is None:
            return Failed(reason=self.reason or (stderr[-1] if stderr else f"The worker exited with {returncode}."))
        vtiles = Path(self.result["vtiles"]).resolve()
        if not vtiles.is_dir() or not vtiles.is_relative_to(out.resolve()):
            return Failed(reason=f"The worker reported tiles at {vtiles}, outside this build's folder.")
        problems = list(self.result.get("problems", []))
        self.log += [f"PROBLEM: {problem}" for problem in problems]
        return Done(filename=self.job.filename, warnings=self.warnings, problems=problems)

    def _write_download(self, vtiles: Path) -> None:
        """The converted archive's entries as they are, then the tiles and the log under ``vector_tiles/``."""
        target = self.job.directory / "download.zip"
        prefix = f"{TILES_FOLDER}/"
        with zipfile.ZipFile(self.job.directory / "converted.zip") as source, zipfile.ZipFile(target, "w") as download:
            for info in source.infolist():
                # A download from an earlier build, uploaded again, would otherwise carry two sets of tiles.
                if info.filename.casefold().startswith(prefix):
                    continue
                download.writestr(info, source.read(info))
            for file in sorted(vtiles.rglob("*")):
                if file.is_file():
                    name = f"{prefix}{vtiles.name}/{file.relative_to(vtiles).as_posix()}"
                    download.write(file, name, compress_type=zipfile.ZIP_DEFLATED)
            download.write(self._log_file(), f"{prefix}{_LOG_NAME}", compress_type=zipfile.ZIP_DEFLATED)


def _lines(stream: IO[bytes]) -> Iterator[str]:
    """Decoded lines of a byte stream, as they arrive. arcpy's own output may be in the console code page."""
    for raw in iter(stream.readline, b""):
        yield raw.decode("utf-8", "replace").rstrip("\r\n")
