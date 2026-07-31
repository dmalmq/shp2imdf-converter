"""Generate a styled QGIS .qgz project for a folder of ODC shapefiles.

The backend's own Python (conda/geopandas) cannot import PyQGIS, so the
generator (``tools/generate_qgis_project.py``) is executed via QGIS's bundled
interpreter, driven by :mod:`subprocess`.

Configuration (env vars):
    QGIS_PYTHON            Path to ``python-qgis.bat`` (or a python that can
                           ``import qgis``). If unset, a few common install
                           locations are probed.
    QGIS_GENERATOR_SCRIPT Path to the generator script. Defaults to
                           ``<repo>/tools/generate_qgis_project.py``.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

QGIS_PYTHON_ENV = "QGIS_PYTHON"
QGIS_SCRIPT_ENV = "QGIS_GENERATOR_SCRIPT"
_TIMEOUT_SECONDS = 300

# Common Windows install locations, newest first.
_DEFAULT_QGIS_PYTHONS = [
    r"C:\Program Files\QGIS 3.42.0\bin\python-qgis.bat",
    r"C:\Program Files\QGIS 3.40.0\bin\python-qgis.bat",
    r"C:\Program Files\QGIS 3.38.0\bin\python-qgis.bat",
]


class QgisUnavailableError(RuntimeError):
    """QGIS is not installed / not configured on this workstation."""


class QgisExportError(RuntimeError):
    """QGIS was found but project generation failed."""


def _resolve_qgis_python() -> str | None:
    env = os.getenv(QGIS_PYTHON_ENV)
    if env:
        return env
    for candidate in _DEFAULT_QGIS_PYTHONS:
        if Path(candidate).exists():
            return candidate
    return None


def _resolve_generator_script() -> Path:
    env = os.getenv(QGIS_SCRIPT_ENV)
    if env:
        return Path(env)
    # backend/src/qgis_export.py -> repo root is parents[2].
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "tools" / "generate_qgis_project.py"


def generate_qgis_project_for_folder(
    folder: Path,
    output_qgz: Path,
    station: str,
) -> None:
    """Write a styled ``.qgz`` for the shapefiles in ``folder``.

    Raises :class:`QgisUnavailableError` if QGIS cannot be located, or
    :class:`QgisExportError` if generation fails.
    """
    qgis_python = _resolve_qgis_python()
    if not qgis_python:
        raise QgisUnavailableError(
            "QGIS is not installed on this workstation (set QGIS_PYTHON to "
            "python-qgis.bat). A styled QGIS project cannot be generated."
        )
    script = _resolve_generator_script()
    if not script.exists():
        raise QgisUnavailableError(f"QGIS generator script not found: {script}")

    cmd = [
        qgis_python,
        str(script),
        "--input", str(folder),
        "--output", str(output_qgz),
        "--station", station,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise QgisUnavailableError(
            f"QGIS interpreter not found: {qgis_python}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise QgisExportError(
            f"QGIS project generation timed out after {_TIMEOUT_SECONDS}s."
        ) from exc

    if result.returncode != 0 or not output_qgz.exists():
        detail = (result.stderr or result.stdout or "").strip()
        raise QgisExportError(
            f"QGIS project generation failed (exit {result.returncode})."
            + (f" {detail[:500]}" if detail else "")
        )