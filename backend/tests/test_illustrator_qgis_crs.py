"""The generated QGIS project must declare the export CRS."""

from __future__ import annotations

from xml.etree import ElementTree

import pytest

from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project

LAYERS = [QgisLayerSpec(table="floor", display_name="Floor", role="polygon")]


@pytest.mark.georef
def test_project_without_crs_is_unchanged() -> None:
    xml = build_qgs_project(LAYERS, gpkg_filename="a.gpkg", project_name="a")
    assert "<authid></authid>" in xml
    assert "<srid>0</srid>" in xml


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
