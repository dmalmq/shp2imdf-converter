"""File Geodatabases for the colour tool: find a Python with GDAL's ``osgeo`` and run ``gdb_worker.py`` in it.

pyogrio cannot update a geodatabase, and copying one through GDAL loses
metadata, ``Shape_Length``/``Shape_Area``, feature datasets and aliases
(measured), so the update happens in place on a copy the caller owns. The
worker turns rows into the same ``LayerInput``s a shapefile gives the planner.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import importlib.util
import json
import logging
import os
from pathlib import Path
import subprocess
import sys

from backend.src.color_theme import ColorTheme, Encoding, LayerInput, Row, SkippedLayer

logger = logging.getLogger(__name__)

WORKER = Path(__file__).with_name("gdb_worker.py")
# Measured on Tokyo (64 classes, 5,996 rewrites): read 1.9 s, apply 16 s.
_TIMEOUT_SECONDS = 120
_ENCODING = Encoding(codec="utf-8", source="gdb")
_ARCGIS_PRO_PYTHON = Path("ArcGIS/Pro/bin/Python/envs/arcgispro-py3/python.exe")


def find_gdal_python() -> Path | None:
    """``GDB_GDAL_PYTHON`` if set; else this interpreter when it has ``osgeo``; else ArcGIS Pro's default Python."""
    configured = os.getenv("GDB_GDAL_PYTHON", "").strip()
    if configured:
        if Path(configured).is_file():
            return Path(configured)
        logger.warning("GDB_GDAL_PYTHON=%s is not a file; geodatabases cannot be recoloured", configured)
        return None
    if importlib.util.find_spec("osgeo") is not None:
        return Path(sys.executable)
    arcgis = Path(os.getenv("ProgramFiles", r"C:\Program Files")) / _ARCGIS_PRO_PYTHON
    return arcgis if arcgis.is_file() else None


def _run(python: Path, args: list[str], stdin: bytes = b"") -> bytes:
    """The worker's stdout. Raises ValueError carrying its last stderr line when it fails or overruns."""
    try:
        done = subprocess.run(
            [str(python), "-I", str(WORKER), *args],
            input=stdin,
            capture_output=True,
            timeout=_TIMEOUT_SECONDS,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"The GDAL worker did not finish: {exc}") from exc
    if done.returncode != 0:
        lines = done.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ValueError(lines[-1] if lines else f"The GDAL worker exited with {done.returncode}")
    return done.stdout


@dataclass(frozen=True, slots=True)
class GdbRead:
    layers: list[LayerInput | SkippedLayer]
    """Every feature class or table carrying the theme's field, as ``<gdb_id>/<name>``."""
    tables: int
    """Every feature class and table in the geodatabase; 0 when it could not be read."""
    category_only: int
    """Those that have the category field and not the theme's field."""


def read_layers(gdb_dir: Path, gdb_id: str, theme: ColorTheme, python: Path) -> GdbRead:
    """What the geodatabase holds for the planner.

    A geodatabase the worker cannot read is one ``unreadable`` entry: it
    might have carried the field, and the operator should hear about it.
    """
    try:
        payload = json.loads(_run(python, ["read", str(gdb_dir), theme.field, theme.category_field]))
    except ValueError as exc:
        logger.warning("Could not read %s: %s", gdb_id, exc)
        return GdbRead(layers=[SkippedLayer(id=gdb_id, reason="unreadable")], tables=0, category_only=0)
    layers: list[LayerInput | SkippedLayer] = []
    for layer in payload["layers"]:
        layer_id = f"{gdb_id}/{layer['name']}"
        if layer["field_type"] != "String":
            layers.append(SkippedLayer(id=layer_id, reason="field_not_text"))
            continue
        # A NULL cell is blank to the planner, as a blank DBF cell is; None would mean "did not decode".
        rows = [Row(index=fid, value=value or "", category=category) for fid, value, category in layer["rows"]]
        layers.append(
            LayerInput(id=layer_id, rows=rows, width=layer["width"], width_unit="characters", encoding=_ENCODING)
        )
    return GdbRead(layers=layers, tables=payload["tables"], category_only=payload["category_only"])


def apply_edits(gdb_dir: Path, field: str, edits: Mapping[str, Mapping[int, str]], python: Path) -> None:
    """Write ``edits`` (layer name to {FID: text}) into the geodatabase in place. ValueError unless every one lands."""
    request = {"edits": {name: {str(fid): text for fid, text in rows.items()} for name, rows in edits.items()}}
    result = json.loads(_run(python, ["apply", str(gdb_dir), field], json.dumps(request).encode("ascii")))
    expected = sum(len(rows) for rows in edits.values())
    if result["updated"] != expected:
        raise ValueError(f"The geodatabase took {result['updated']} of {expected} edits")
