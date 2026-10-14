"""ArcGIS Pro's Python, and whether its ``arcpy`` is licensed for the account running this server.

``osgeo`` in that Python needs no licence (``gdb.py``); ``arcpy`` does, and
without one ``import arcpy`` raises "The Product License has not been
initialized." Vector tiles need ``arcpy``, so the server asks once at startup,
off the event loop: the import takes seconds.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
import subprocess
import threading
from typing import Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_PRO_PYTHON = Path("ArcGIS/Pro/bin/Python/envs/arcgispro-py3/python.exe")
_PROBE = "import arcpy; print(arcpy.ProductInfo())"
_PROBE_TIMEOUT_SECONDS = 180


def pro_python() -> Path | None:
    """ArcGIS Pro's default ``arcgispro-py3`` interpreter, when Pro is installed under Program Files."""
    python = Path(os.getenv("ProgramFiles", r"C:\Program Files")) / _PRO_PYTHON
    return python if python.is_file() else None


def find_arcpy_python() -> Path | None:
    """``ARCPY_PYTHON`` if set, else ArcGIS Pro's default Python. None when neither is a file."""
    configured = os.getenv("ARCPY_PYTHON", "").strip()
    if configured:
        if Path(configured).is_file():
            return Path(configured)
        logger.warning("ARCPY_PYTHON=%s is not a file; vector tiles cannot be built", configured)
        return None
    return pro_python()


class ArcpyChecking(BaseModel):
    state: Literal["checking"] = "checking"


class ArcpyAvailable(BaseModel):
    state: Literal["available"] = "available"
    product: str
    """``arcpy.ProductInfo()``: ArcView, ArcEditor or ArcInfo for Pro Basic, Standard or Advanced."""
    python: Path = Field(exclude=True)


class ArcpyUnavailable(BaseModel):
    state: Literal["unavailable"] = "unavailable"
    reason: Literal["no_python", "not_licensed", "failed"]
    detail: str
    """What the probe saw, in English, for the operator who has to fix it."""


ArcpyStatus = ArcpyChecking | ArcpyAvailable | ArcpyUnavailable


def probe_arcpy(python: Path | None) -> ArcpyAvailable | ArcpyUnavailable:
    """Run ``import arcpy`` in ``python`` and read the licence level it reports."""
    if python is None:
        return ArcpyUnavailable(
            reason="no_python", detail="No ArcGIS Pro Python found; install ArcGIS Pro or set ARCPY_PYTHON."
        )
    try:
        done = subprocess.run(
            [str(python), "-I", "-c", _PROBE],
            capture_output=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ArcpyUnavailable(reason="failed", detail=f"{python} did not answer: {exc}")
    stderr = done.stderr.decode("utf-8", "replace").strip().splitlines()
    stdout = done.stdout.decode("utf-8", "replace").strip().splitlines()
    if done.returncode != 0:
        line = stderr[-1] if stderr else f"exit code {done.returncode}"
        reason = "not_licensed" if "License" in line else "failed"
        return ArcpyUnavailable(reason=reason, detail=f"import arcpy failed: {line}")
    product = stdout[-1].strip() if stdout else ""
    if product in ("", "NotInitialized"):
        return ArcpyUnavailable(reason="not_licensed", detail=f"arcpy.ProductInfo() is {product or 'empty'}")
    return ArcpyAvailable(product=product, python=python)


class ArcpyProbe:
    """Holds the probe's answer; ``checking`` until the background run finishes."""

    def __init__(self, python: Path | None) -> None:
        self.python = python
        self.status: ArcpyStatus = ArcpyChecking()

    def start(self) -> None:
        threading.Thread(target=self._run, name="arcpy-probe", daemon=True).start()

    def _run(self) -> None:
        self.status = probe_arcpy(self.python)
        if isinstance(self.status, ArcpyAvailable):
            logger.info("Vector tiles available: arcpy %s in %s", self.status.product, self.python)
        else:
            logger.info("Vector tiles unavailable: %s", self.status.detail)
