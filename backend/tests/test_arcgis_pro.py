"""Whether arcpy is usable, decided from what a stand-in interpreter prints the way ArcGIS Pro's does."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest

from backend.src.arcgis_pro import ArcpyAvailable, ArcpyUnavailable, find_arcpy_python, probe_arcpy

pytestmark = [
    pytest.mark.colortheme,
    pytest.mark.vectortiles,
    pytest.mark.skipif(sys.platform != "win32", reason="the stand-in interpreter is a .cmd file"),
]


def _python(tmp_path: Path, body: str) -> Path:
    script = tmp_path / "python.cmd"
    script.write_text(f"@echo off\r\n{body}\r\n", encoding="ascii")
    return script


def test_a_licensed_arcpy_is_available(tmp_path) -> None:
    status = probe_arcpy(_python(tmp_path, "echo ArcInfo"))

    assert isinstance(status, ArcpyAvailable)
    assert status.product == "ArcInfo"
    assert status.model_dump() == {"state": "available", "product": "ArcInfo"}


def test_an_uninitialised_licence_is_not_licensed(tmp_path) -> None:
    status = probe_arcpy(_python(tmp_path, "echo NotInitialized"))

    assert status == ArcpyUnavailable(reason="not_licensed", detail="arcpy.ProductInfo() is NotInitialized")


def test_an_import_that_raises_for_the_licence_is_not_licensed(tmp_path) -> None:
    python = _python(tmp_path, "echo RuntimeError: The Product License has not been initialized. 1>&2\r\nexit /b 1")

    status = probe_arcpy(python)

    assert status == ArcpyUnavailable(
        reason="not_licensed", detail="import arcpy failed: RuntimeError: The Product License has not been initialized."
    )


def test_no_python_is_its_own_reason() -> None:
    assert isinstance(probe_arcpy(None), ArcpyUnavailable)
    assert probe_arcpy(None).reason == "no_python"


def test_arcpy_python_overrides_the_program_files_lookup(tmp_path, monkeypatch) -> None:
    python = _python(tmp_path, "echo ArcView")
    monkeypatch.setenv("ARCPY_PYTHON", str(python))
    assert find_arcpy_python() == python

    monkeypatch.setenv("ARCPY_PYTHON", str(tmp_path / "missing.exe"))
    assert find_arcpy_python() is None
