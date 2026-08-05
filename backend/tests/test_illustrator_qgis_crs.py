"""The generated QGIS project must declare the export CRS."""

from __future__ import annotations

import subprocess
from pathlib import Path
from xml.etree import ElementTree

import pytest

from backend.src import qgis_export
from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project

LAYERS = [QgisLayerSpec(table="floor", display_name="Floor", role="polygon")]


@pytest.mark.georef
def test_project_without_crs_is_unchanged() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a")
    assert "<authid></authid>" in xml
    assert "<srid>0</srid>" in xml
    # Nothing to project onto, so the flag stays off and QGIS keeps treating the
    # artwork-space output as having an unknown CRS.
    assert '<ProjectionsEnabled type="int">0</ProjectionsEnabled>' in xml


@pytest.mark.georef
def test_declared_crs_is_switched_on_so_qgis_does_not_discard_it() -> None:
    """The assertion the string-only tests were missing.

    A ``<projectCrs>`` element is necessary but not sufficient: QGIS parses it
    and then throws it away unless projections are enabled in ``<properties>``,
    so a project can name the right CRS in its XML and still open without one.
    Confirmed against QGIS 3.42 - see ``test_real_qgis_resolves_the_export_crs``.
    """
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:6677")
    assert '<ProjectionsEnabled type="int">1</ProjectionsEnabled>' in xml

@pytest.mark.georef
def test_project_declares_the_requested_authority_code() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:6677")
    assert "<authid>EPSG:6677</authid>" in xml
    assert "<srid>6677</srid>" in xml
    assert "<geographicflag>false</geographicflag>" in xml


@pytest.mark.georef
def test_geographic_crs_sets_the_geographic_flag() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:4326")
    assert "<authid>EPSG:4326</authid>" in xml
    assert "<geographicflag>true</geographicflag>" in xml


@pytest.mark.georef
def test_both_project_and_layer_carry_the_crs_and_xml_parses() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a", crs="EPSG:6677")
    assert xml.count("<authid>EPSG:6677</authid>") >= 2
    assert ElementTree.fromstring(xml).tag == "qgis"


# The probe runs inside QGIS's own interpreter, prints one line, and exits; the
# backend's Python cannot import PyQGIS, which is why this goes through a
# subprocess the way backend.src.qgis_export already does.
_PYQGIS_PROBE = """
import sys
from qgis.core import QgsApplication, QgsProject
QgsApplication.setPrefixPath(sys.argv[1], True)
app = QgsApplication([], False)
app.initQgis()
project = QgsProject.instance()
project.read(sys.argv[2])
print("AUTHID=" + project.crs().authid())
app.exitQgis()
"""


@pytest.mark.georef
def test_real_qgis_resolves_the_export_crs(tmp_path: Path) -> None:
    """Load a generated project in the real QGIS and assert the CRS survives.

    Every other test here inspects strings, which is how a project that named
    EPSG:6677 in its XML yet opened with no CRS at all passed a full suite. Only
    QGIS can judge whether its own format was satisfied, so this asks it.

    Skipped when QGIS is not installed - the rest of the suite never invokes it.
    """
    qgis_python = qgis_export._resolve_qgis_python()
    if not qgis_python or not Path(qgis_python).exists():
        pytest.skip("QGIS is not installed on this machine")
    prefix = Path(qgis_python).parent.parent / "apps" / "qgis"
    if not prefix.exists():
        pytest.skip(f"QGIS prefix not found at {prefix}")

    project = tmp_path / "probe.qgs"
    project.write_text(
        build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="probe", crs="EPSG:6677"),
        encoding="utf-8",
    )
    script = tmp_path / "probe_pyqgis.py"
    script.write_text(_PYQGIS_PROBE, encoding="utf-8")

    result = subprocess.run(
        [qgis_python, str(script), str(prefix), str(project)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    authids = [line for line in result.stdout.splitlines() if line.startswith("AUTHID=")]
    assert authids, f"probe printed no verdict.\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert authids[-1] == "AUTHID=EPSG:6677", f"QGIS did not honour the declared CRS: {authids[-1]}"
