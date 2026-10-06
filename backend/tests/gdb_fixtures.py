"""File Geodatabases for the colour tool's tests, built and read through ``gdb_fixture_tool.py``.

The tool runs in the same interpreter as ``gdb_worker.py`` (``find_gdal_python``),
so a test needs no ``osgeo`` in the backend's own Python.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess

TOOL = Path(__file__).with_name("gdb_fixture_tool.py")

Rows = list[dict[str, str | None]]


def _tool(python: Path, *args: str, stdin: bytes = b"") -> dict:
    done = subprocess.run([str(python), "-I", str(TOOL), *args], input=stdin, capture_output=True, timeout=120)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace"))
    return json.loads(done.stdout)


def space(name: str, rows: list[tuple[str | None, str | None]], *, width: int = 12, dataset: str | None = "Station") -> dict:
    """A Space class: ``name``, ``category`` and ``color2`` (``width`` characters), indexed on color2."""
    return {
        "name": name,
        "dataset": dataset,
        "fields": [["name", 20], ["category", 10], ["color2", width]],
        "index": ["color2"],
        "rows": [{"name": f"room {index}", "category": category, "color2": color2} for index, (color2, category) in enumerate(rows)],
    }


def build_gdb(path: Path, classes: list[dict], python: Path) -> Path:
    _tool(python, "build", str(path), stdin=json.dumps({"classes": classes}).encode("ascii"))
    return path


def dump_gdb(path: Path, python: Path) -> dict:
    """``{"layers": {name: {"widths", "rows": [{"fid", "fields", "wkb"}]}}, "tables": {name: file stem}}``."""
    return _tool(python, "dump", str(path))


def table_stems(path: Path, python: Path) -> dict[str, str]:
    """Table name to the stem its files share, e.g. ``a00000009``."""
    return _tool(python, "tables", str(path))["tables"]


def filter_fids(path: Path, layer: str, where: str, python: Path) -> list[int]:
    return _tool(python, "filter", str(path), layer, where)["fids"]


def gdb_files(path: Path, prefix: str) -> list[tuple[str, bytes]]:
    """Every file of the geodatabase as upload entries under ``prefix``, in name order."""
    return [(f"{prefix}/{file.name}", file.read_bytes()) for file in sorted(path.iterdir()) if file.is_file()]


def fingerprint(path: Path) -> dict[str, tuple[str, int]]:
    """File name to (sha256, mtime in ns)."""
    return {
        file.name: (hashlib.sha256(file.read_bytes()).hexdigest(), file.stat().st_mtime_ns)
        for file in sorted(path.iterdir())
        if file.is_file()
    }
