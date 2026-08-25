"""The QGIS project bundled with every Open Data Contest shapefile export."""

from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import tempfile
from xml.etree import ElementTree
import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import LineString, Polygon

from backend.src import qgis_export
from backend.src.odc_qgis import (
    FLOOR_KIND_ORDER,
    SITE_KIND_ORDER,
    OdcQgisLayer,
    build_odc_qgs_project,
)
from backend.src.shapefile_exporter import ODC_EXPORT_CRS, ODC_FLOOR_LAYER_GEOMS
from backend.tests.test_api import _upload_all_shapefiles, _write_imdf_schema_shapefiles

_OPENING_RED = "#e31a1c"

_BASEMENT_LEVEL_ID = "55555555-5555-4555-8555-555555555551"
_BASEMENT_UNITS = (
    ("55555555-5555-4555-8555-555555555552", "B002"),
    ("55555555-5555-4555-8555-555555555553", "B005"),
)


def _write_basement_floor(root: Path) -> None:
    """Add a basement to the 1F-only IMDF fixture: two Space codes and an Opening.

    One floor cannot show grouping, one category cannot show a color per
    category, and the base fixture has no Opening at all.
    """
    floor_geom = Polygon(
        [(139.7001, 35.6891), (139.7009, 35.6891), (139.7009, 35.6899), (139.7001, 35.6899), (139.7001, 35.6891)]
    )
    gpd.GeoDataFrame(
        {
            "id": [_BASEMENT_LEVEL_ID],
            "category": ["1"],
            "name": ["Basement"],
            "ordinal": [-1.0],
            "short_name": ["B1F"],
            "source": ["1"],
        },
        geometry=[floor_geom],
        crs="EPSG:4326",
    ).to_file(root / "Demo_B1_Floor.shp", driver="ESRI Shapefile", index=False)

    gpd.GeoDataFrame(
        {
            "id": [unit_id for unit_id, _code in _BASEMENT_UNITS],
            "category": [code for _unit_id, code in _BASEMENT_UNITS],
            "floor_id": [_BASEMENT_LEVEL_ID] * len(_BASEMENT_UNITS),
            "name": ["Kiosk", "Ticket Office"],
            "source": ["1"] * len(_BASEMENT_UNITS),
        },
        geometry=[
            Polygon([(139.7002, 35.6892), (139.7004, 35.6892), (139.7004, 35.6894), (139.7002, 35.6894), (139.7002, 35.6892)]),
            Polygon([(139.7005, 35.6892), (139.7007, 35.6892), (139.7007, 35.6894), (139.7005, 35.6894), (139.7005, 35.6892)]),
        ],
        crs="EPSG:4326",
    ).to_file(root / "Demo_B1_Space.shp", driver="ESRI Shapefile", index=False)

    gpd.GeoDataFrame(
        {
            "id": ["55555555-5555-4555-8555-555555555554"],
            "floor_id": [_BASEMENT_LEVEL_ID],
            "name": ["Kiosk Door"],
            "source": ["1"],
        },
        geometry=[LineString([(139.7004, 35.6892), (139.7004, 35.6894)])],
        crs="EPSG:4326",
    ).to_file(root / "Demo_B1_Opening.shp", driver="ESRI Shapefile", index=False)

    gpd.GeoDataFrame(
        {
            "id": ["55555555-5555-4555-8555-555555555555"],
            "floor_id": [_BASEMENT_LEVEL_ID],
            "source": ["1"],
        },
        geometry=[LineString([(139.7001, 35.6891), (139.7009, 35.6891)])],
        crs="EPSG:4326",
    ).to_file(root / "Demo_B1_Drawing.shp", driver="ESRI Shapefile", index=False)


def _export_open_data_bundle(test_client) -> zipfile.ZipFile:
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        _write_imdf_schema_shapefiles(root)
        _write_basement_floor(root)
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))
    assert response.status_code == 201, response.text
    session_id = response.json()["session_id"]

    export = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={
            "profile": "odc2026",
            "mode": "source_update",
            "encoding": "utf-8",
            "export_name": "DemoSta",
            "include_report": True,
        },
    )
    assert export.status_code == 200, export.text
    return zipfile.ZipFile(io.BytesIO(export.content))


@pytest.fixture()
def bundle(test_client) -> zipfile.ZipFile:
    return _export_open_data_bundle(test_client)


def _project(bundle: zipfile.ZipFile) -> ElementTree.Element:
    return ElementTree.fromstring(bundle.read("DemoSta_qgis.qgs").decode("utf-8"))


def _tree(project: ElementTree.Element) -> ElementTree.Element:
    return project.find("layer-tree-group")


def _maplayer(project: ElementTree.Element, stem: str) -> ElementTree.Element:
    return next(
        layer
        for layer in project.iter("maplayer")
        if layer.findtext("datasource") == f"./{stem}.shp"
    )


def _symbol_options(symbol: ElementTree.Element) -> dict[str, str]:
    return {
        option.get("name"): option.get("value")
        for option in symbol.iter("Option")
        if option.get("name") and option.get("value") is not None
    }


Box = tuple[float, float, float, float]


def _attr_extent(element: ElementTree.Element) -> Box:
    return tuple(float(element.get(key)) for key in ("xmin", "ymin", "xmax", "ymax"))


def _child_extent(element: ElementTree.Element) -> Box:
    return tuple(float(element.findtext(key)) for key in ("xmin", "ymin", "xmax", "ymax"))


def _saved_views(project: ElementTree.Element) -> dict[str, Box]:
    """Every extent the project declares, by the element that carries it."""
    return {
        "mapcanvas": _child_extent(project.find("mapcanvas/extent")),
        "DefaultViewExtent": _attr_extent(project.find("ProjectViewSettings/DefaultViewExtent")),
        "PresetFullExtent": _attr_extent(project.find("ProjectViewSettings/PresetFullExtent")),
    }


def _layer_union(directory: Path) -> Box:
    boxes = [gpd.read_file(shp).total_bounds for shp in sorted(directory.glob("*.shp"))]
    assert boxes
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _contains(outer: Box, inner: Box) -> bool:
    return (
        outer[0] < inner[0] and outer[1] < inner[1] and outer[2] > inner[2] and outer[3] > inner[3]
    )



@pytest.mark.phase5
def test_open_data_bundle_ships_a_qgis_project(bundle) -> None:
    assert "DemoSta_qgis.qgs" in bundle.namelist()
    report = json.loads(bundle.read("export_report.json").decode("utf-8"))
    assert report["qgis_project"] == "DemoSta_qgis.qgs"


@pytest.mark.phase5
def test_project_groups_every_layer_under_its_own_floor(bundle) -> None:
    tree = _tree(_project(bundle))
    groups = tree.findall("layer-tree-group")
    # Top floor first, basements last - the order the building is read in.
    assert [group.get("name") for group in groups] == ["1F", "B1F"]
    for group, token in zip(groups, ("1", "B1")):
        sources = [layer.get("source") for layer in group.findall("layer-tree-layer")]
        assert sources, f"{group.get('name')} group is empty"
        assert all(source.startswith(f"./DemoSta_{token}_") for source in sources), sources
    # Whole-site layers stay outside the floor groups, below them.
    assert [layer.get("name") for layer in tree.findall("layer-tree-layer")] == ["Building", "Site"]


@pytest.mark.phase5
def test_floor_group_stacks_points_over_lines_over_polygons(bundle) -> None:
    group = next(
        item for item in _tree(_project(bundle)).findall("layer-tree-group") if item.get("name") == "B1F"
    )
    kinds = [layer.get("name") for layer in group.findall("layer-tree-layer")]
    # The floor outline is the backdrop; openings must not be buried under Space.
    assert kinds == ["Opening", "Drawing", "Space", "Floor"]


@pytest.mark.phase5
def test_openings_are_red(bundle) -> None:
    renderer = _maplayer(_project(bundle), "DemoSta_B1_Opening").find("renderer-v2")
    assert renderer.get("type") == "singleSymbol"
    symbol = renderer.find("symbols/symbol")
    assert symbol.get("type") == "line"
    assert _symbol_options(symbol)["line_color"] == "227,26,28,255"


@pytest.mark.phase5
def test_each_space_category_gets_its_own_color(bundle) -> None:
    renderer = _maplayer(_project(bundle), "DemoSta_B1_Space").find("renderer-v2")
    assert renderer.get("type") == "categorizedSymbol"
    assert renderer.get("attr") == "category"

    categories = renderer.findall("categories/category")
    assert [category.get("value") for category in categories] == ["B002", "B005"]
    # The legend names the code, so a reviewer does not have to look it up.
    assert [category.get("label") for category in categories] == ["B002 office", "B005 tickets"]

    colors = [
        _symbol_options(symbol)["color"] for symbol in renderer.findall("symbols/symbol")
    ]
    assert len(colors) == len(categories)
    assert len(set(colors)) == len(colors), colors


@pytest.mark.phase5
def test_single_category_layers_are_not_left_unstyled(bundle) -> None:
    # 1F has one Space code; a categorized renderer with one class is still the
    # right answer, since a second code appearing later must not recolor it.
    renderer = _maplayer(_project(bundle), "DemoSta_1_Space").find("renderer-v2")
    assert renderer.get("type") == "categorizedSymbol"
    assert [category.get("value") for category in renderer.findall("categories/category")] == ["B001"]


@pytest.mark.phase5
def test_project_declares_the_crs_the_shapefiles_were_written_in(bundle) -> None:
    project = _project(bundle)
    assert project.findtext("projectCrs/spatialrefsys/authid") == "EPSG:6668"
    # A CRS QGIS parses and then discards is the failure this pairing prevents.
    assert project.findtext("properties/SpatialRefSys/ProjectionsEnabled") == "1"


@pytest.mark.phase5
def test_project_opens_on_the_data(bundle, tmp_path: Path) -> None:
    """Without a saved view the project opens on empty space.

    QGIS has no reason to guess where a generated project's data is, so it
    opens at its default extent - nowhere near a Japanese station - and the
    layers are all there, just off screen.
    """
    bundle.extractall(tmp_path)
    union = _layer_union(tmp_path)
    for name, extent in _saved_views(_project(bundle)).items():
        assert _contains(extent, union), f"{name} {extent} does not cover the data {union}"


@pytest.mark.phase5
def test_saved_view_matches_the_export_crs(bundle) -> None:
    project = _project(bundle)
    # A canvas in the wrong units reads the extent numbers as metres.
    assert project.findtext("mapcanvas/units") == "degrees"
    for path in ("mapcanvas/destinationsrs", "ProjectViewSettings/DefaultViewExtent"):
        assert project.findtext(f"{path}/spatialrefsys/authid") == "EPSG:6668"


@pytest.mark.phase5
def test_a_point_only_export_still_has_an_extent_to_open_at() -> None:
    """A zero-area extent is what QGIS shows nothing for.

    One Facility point (or a single vertical Opening) has no width or height,
    and handing that to QGIS reproduces the blank canvas this all fixes.
    """
    project = ElementTree.fromstring(
        build_odc_qgs_project(
            [
                OdcQgisLayer(
                    stem="X_1_Facility",
                    kind="Facility",
                    floor="1",
                    bounds=(139.7, 35.68, 139.7, 35.68),
                )
            ],
            project_name="X",
            crs=ODC_EXPORT_CRS,
        )
    )
    for name, (xmin, ymin, xmax, ymax) in _saved_views(project).items():
        assert xmax > xmin and ymax > ymin, f"{name} is degenerate"
        assert xmin < 139.7 < xmax and ymin < 35.68 < ymax, name


@pytest.mark.phase5
def test_a_project_with_no_layers_claims_no_extent() -> None:
    project = ElementTree.fromstring(
        build_odc_qgs_project([], project_name="X", crs=ODC_EXPORT_CRS)
    )
    assert project.find("mapcanvas") is None
    assert project.find("ProjectViewSettings") is None


@pytest.mark.phase5
def test_every_odc_layer_can_be_placed_and_styled() -> None:
    """A new ODC layer must not fall out of the project unnoticed.

    ``build_odc_qgs_project`` drops what it cannot order or style, so adding a
    layer to the export without a style here would silently ship a project
    missing it.
    """
    placed = set(FLOOR_KIND_ORDER) | set(SITE_KIND_ORDER)
    assert set(ODC_FLOOR_LAYER_GEOMS) <= placed
    assert {"Site", "Building"} <= placed

    layers = [OdcQgisLayer(stem=f"X_1_{kind}", kind=kind, floor="1") for kind in ODC_FLOOR_LAYER_GEOMS]
    layers += [OdcQgisLayer(stem=f"X_{kind}", kind=kind) for kind in ("Site", "Building")]
    project = ElementTree.fromstring(
        build_odc_qgs_project(layers, project_name="X", crs=ODC_EXPORT_CRS)
    )
    assert len(project.findall("projectlayers/maplayer")) == len(layers)


@pytest.mark.phase5
def test_mezzanine_sits_between_the_floors_it_bridges() -> None:
    tokens = ["B2", "1", "M2", "3", "2", "B1", "odd"]
    project = ElementTree.fromstring(
        build_odc_qgs_project(
            [OdcQgisLayer(stem=f"X_{token}_Floor", kind="Floor", floor=token) for token in tokens],
            project_name="X",
            crs=ODC_EXPORT_CRS,
        )
    )
    groups = [group.get("name") for group in project.find("layer-tree-group").findall("layer-tree-group")]
    assert groups == ["3F", "2F", "M2F", "1F", "B1F", "B2F", "odd"]


# The probe runs inside QGIS's own interpreter, prints one line, and exits; the
# backend's Python cannot import PyQGIS, which is why this goes through a
# subprocess the way backend.src.qgis_export already does.
_PYQGIS_PROBE = """
import json
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from qgis.core import QgsApplication, QgsLayerTreeGroup, QgsProject
from qgis.gui import QgsMapCanvas
from qgis.PyQt.QtXml import QDomDocument

QgsApplication.setPrefixPath(sys.argv[1], True)
app = QgsApplication([], True)
app.initQgis()
project = QgsProject.instance()
project.read(sys.argv[2])
root = project.layerTreeRoot()

groups = {}
for child in root.children():
    if isinstance(child, QgsLayerTreeGroup):
        groups[child.name()] = [node.layer().name() if node.layer() else None for node in child.children()]

layers = {}
data_extent = None
for layer in project.mapLayers().values():
    renderer = layer.renderer()
    entry = {"valid": layer.isValid(), "features": layer.featureCount(), "renderer": renderer.type()}
    if renderer.type() == "singleSymbol":
        entry["color"] = renderer.symbol().color().name()
    if renderer.type() == "categorizedSymbol":
        entry["attr"] = renderer.classAttribute()
        entry["categories"] = [
            [str(category.value()), category.label(), category.symbol().color().name()]
            for category in renderer.categories()
        ]
    layers[layer.source().replace(chr(92), "/").rsplit("/", 1)[-1]] = entry
    if data_extent is None:
        data_extent = layer.extent()
    else:
        data_extent.combineExtentWith(layer.extent())


def box(rect):
    if rect is None or rect.isNull():
        return None
    return [rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum()]


# The extent the GUI restores lives in <mapcanvas>, which only a canvas reads.
document = QDomDocument()
with open(sys.argv[2], "r", encoding="utf-8") as handle:
    document.setContent(handle.read())
canvas = QgsMapCanvas()
canvas.setDestinationCrs(project.crs())
canvas.setLayers(list(project.mapLayers().values()))
canvas.readProject(document)

print("VERDICT=" + json.dumps({
    "crs": project.crs().authid(),
    "groups": groups,
    "layers": layers,
    "data": box(data_extent),
    "canvas": box(canvas.extent()),
    "default_view": box(project.viewSettings().defaultViewExtent()),
    "preset_full": box(project.viewSettings().presetFullExtent()),
}))
app.exitQgis()
"""


@pytest.mark.phase5
def test_real_qgis_opens_the_bundled_project(bundle, tmp_path: Path) -> None:
    """Extract the bundle and let QGIS itself judge the project.

    Every other test here inspects strings, and a project can name the right
    CRS, groups and colors in its XML while QGIS resolves none of them - a
    broken relative datasource alone is enough. Only QGIS can say whether its
    own format was satisfied, so this asks it.

    Skipped when QGIS is not installed; the rest of the suite never invokes it.
    """
    qgis_python = qgis_export._resolve_qgis_python()
    if not qgis_python or not Path(qgis_python).exists():
        pytest.skip("QGIS is not installed on this machine")
    prefix = Path(qgis_python).parent.parent / "apps" / "qgis"
    if not prefix.exists():
        pytest.skip(f"QGIS prefix not found at {prefix}")

    bundle.extractall(tmp_path)
    script = tmp_path / "probe_pyqgis.py"
    script.write_text(_PYQGIS_PROBE, encoding="utf-8")

    result = subprocess.run(
        [qgis_python, str(script), str(prefix), str(tmp_path / "DemoSta_qgis.qgs")],
        capture_output=True,
        text=True,
        timeout=300,
    )
    verdicts = [line for line in result.stdout.splitlines() if line.startswith("VERDICT=")]
    assert verdicts, f"probe printed no verdict.\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    verdict = json.loads(verdicts[-1][len("VERDICT=") :])

    assert verdict["crs"] == "EPSG:6668"
    assert list(verdict["groups"]) == ["1F", "B1F"]
    assert verdict["groups"]["B1F"] == ["Opening", "Drawing", "Space", "Floor"]

    layers = verdict["layers"]
    unresolved = [name for name, entry in layers.items() if not entry["valid"]]
    assert not unresolved, f"QGIS could not resolve {unresolved}"

    assert layers["DemoSta_B1_Opening.shp"]["color"] == _OPENING_RED
    spaces = layers["DemoSta_B1_Space.shp"]
    assert spaces["attr"] == "category"
    assert [entry[0] for entry in spaces["categories"]] == ["B002", "B005"]
    assert len({entry[2] for entry in spaces["categories"]}) == 2

    # The view QGIS resolves has to sit on the data, from whichever of the
    # three routes it takes: the restored canvas, the default view extent, or
    # Zoom Full. A project that opens on empty space is the bug here.
    data = tuple(verdict["data"])
    assert _contains(tuple(verdict["default_view"]), data), verdict["default_view"]
    assert _contains(tuple(verdict["preset_full"]), data), verdict["preset_full"]
    canvas = tuple(verdict["canvas"])
    # The canvas widens one axis to its own aspect ratio, so it only has to
    # overlap generously rather than contain.
    assert canvas[0] < data[2] and canvas[2] > data[0], canvas
    assert canvas[1] < data[3] and canvas[3] > data[1], canvas
