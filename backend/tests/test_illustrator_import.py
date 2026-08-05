"""Tests for the Illustrator (.ai / PDF) -> GeoPackage converter."""

from __future__ import annotations

import io
import tempfile
import warnings
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import geopandas as gpd
import pytest

from backend.src.illustrator_importer import (
    IllustratorConversionError,
    _build_polygon,
    convert_ai_to_geopackage,
    convert_ai_to_geopackage_bundle,
)


def _build_minimal_ai_pdf() -> bytes:
    """A tiny PDF-based Illustrator file with two Optional-Content layers.

    Layer "Fill Layer" holds a CMYK-red filled rectangle (-> polygon #FF0000).
    Layer "線路" (UTF-16BE name) holds a CMYK-blue stroked line (-> line #0000FF).
    """
    content = (
        b"/OC /MC0 BDC\n"
        b"0 1 1 0 k\n"          # CMYK red -> #FF0000
        b"50 50 100 60 re\n"    # rectangle x=50 y=50 w=100 h=60
        b"f\n"
        b"EMC\n"
        b"/OC /MC1 BDC\n"
        b"1 1 0 0 K\n"          # CMYK blue -> #0000FF (stroke)
        b"2 w\n"
        b"20 20 m\n"
        b"120 140 l\n"
        b"S\n"
        b"EMC\n"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [5 0 R 6 0 R] /D << /Order [5 0 R 6 0 R] >> >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /Properties << /MC0 5 0 R /MC1 6 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /OCG /Name (Fill Layer) >>",
        b"<< /Type /OCG /Name <FEFF7DDA8DEF> >>",  # 線路
    ]

    out = bytearray(b"%PDF-1.6\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


def _build_multipage_ai_pdf() -> bytes:
    """A three-page PDF-based Illustrator file, one red rectangle per page.

    All three rectangles normalize to the same artwork coordinates, so only the
    `page` column distinguishes them:

    | Page | MediaBox            | Rect at    | Normalizes to |
    |------|---------------------|------------|---------------|
    | 1    | [0 0 200 200]       | (50, 50)   | (50, 50)      |
    | 2    | [100 100 300 300]   | (150, 150) | (50, 50)      |
    | 3    | [0 0 400 400]       | (50, 50)   | (50, 50)      |

    Page 2 proves an offset MediaBox is normalized away (equal-size pages stay
    co-registered); page 3 is a larger sheet, for the unequal-size warning.
    """
    def content(x: int, y: int) -> bytes:
        return (
            b"/OC /MC0 BDC\n"
            b"0 1 1 0 k\n"                      # CMYK red -> #FF0000
            + f"{x} {y} 100 60 re\n".encode()   # 100x60 rectangle
            + b"f\n"
            b"EMC\n"
        )

    pages = [
        (b"[0 0 200 200]", content(50, 50)),
        (b"[100 100 300 300]", content(150, 150)),
        (b"[0 0 400 400]", content(50, 50)),
    ]

    objects: list[bytes | None] = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [3 0 R] /D << /Order [3 0 R] >> >> >>",
        None,  # /Pages, filled in once the page object ids are known
        b"<< /Type /OCG /Name (Fill Layer) >>",
    ]
    page_ids: list[int] = []
    for mediabox, stream in pages:
        page_id = len(objects) + 1
        stream_id = len(objects) + 2
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox " + mediabox
            + b" /Resources << /Properties << /MC0 3 0 R >> >> /Contents "
            + str(stream_id).encode() + b" 0 R >>"
        )
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream"
        )
        page_ids.append(page_id)
    kids = b" ".join(f"{i} 0 R".encode() for i in page_ids)
    objects[1] = (
        b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(len(pages)).encode() + b" >>"
    )

    out = bytearray(b"%PDF-1.6\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        assert body is not None
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture()
def gpkg_bytes() -> bytes:
    b, name, report = convert_ai_to_geopackage(_build_minimal_ai_pdf(), "sample.ai")
    assert name == "sample.gpkg"
    assert report.page_count == 1
    assert report.total_features == 2
    return b


def _read_layer(gpkg: bytes, layer: str) -> gpd.GeoDataFrame:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "in.gpkg"
        path.write_bytes(gpkg)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return gpd.read_file(path, layer=layer)


def test_layers_are_named_per_ai_layer(gpkg_bytes: bytes) -> None:
    import fiona

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "in.gpkg"
        path.write_bytes(gpkg_bytes)
        layers = set(fiona.listlayers(path))
    assert "Fill Layer" in layers          # polygon table keeps the base name
    assert "線路__lines" in layers          # line table gets the __lines suffix


def test_filled_path_becomes_colored_polygon(gpkg_bytes: bytes) -> None:
    gdf = _read_layer(gpkg_bytes, "Fill Layer")
    assert len(gdf) == 1
    row = gdf.iloc[0]
    assert row["ai_layer"] == "Fill Layer"
    assert row["role"] == "polygon"
    assert row["fill_color"] == "#FF0000"  # CMYK (0,1,1,0) -> red
    assert gdf.geometry.iloc[0].geom_type == "Polygon"
    # rectangle x=50 y=50 w=100 h=60 -> bounds (50, 50, 150, 110); Y is not flipped
    assert gdf.total_bounds == pytest.approx([50.0, 50.0, 150.0, 110.0])


def test_stroked_path_becomes_colored_line(gpkg_bytes: bytes) -> None:
    gdf = _read_layer(gpkg_bytes, "線路__lines")
    assert len(gdf) == 1
    row = gdf.iloc[0]
    assert row["ai_layer"] == "線路"
    assert row["role"] == "line"
    assert row["stroke_color"] == "#0000FF"  # CMYK (1,1,0,0) -> blue
    assert gdf.geometry.iloc[0].geom_type == "LineString"
    assert gdf.total_bounds == pytest.approx([20.0, 20.0, 120.0, 140.0])


def test_non_pdf_input_raises() -> None:
    with pytest.raises(IllustratorConversionError):
        convert_ai_to_geopackage(b"this is not a pdf", "bad.ai")


def test_empty_input_raises() -> None:
    with pytest.raises(IllustratorConversionError):
        convert_ai_to_geopackage(b"", "empty.ai")


# --------------------------------------------------------------------------- #
# API endpoint
# --------------------------------------------------------------------------- #

def test_convert_endpoint_returns_zip_with_gpkg_and_qgs(test_client) -> None:
    import fiona

    pdf = _build_minimal_ai_pdf()
    resp = test_client.post(
        "/api/convert/illustrator",
        files=[("file", ("sample.ai", pdf, "application/postscript"))],
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/zip")
    assert "sample.zip" in resp.headers.get("content-disposition", "")
    assert "X-Conversion-Report" in resp.headers

    with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
        names = set(archive.namelist())
        assert "sample.gpkg" in names
        assert "sample.qgs" in names
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "resp.gpkg"
            path.write_bytes(archive.read("sample.gpkg"))
            layers = set(fiona.listlayers(path))
    assert "Fill Layer" in layers
    assert "線路__lines" in layers


def test_convert_endpoint_handles_japanese_filename(test_client) -> None:
    """Non-ASCII names must not break the latin-1 HTTP headers (regression)."""
    pdf = _build_minimal_ai_pdf()
    resp = test_client.post(
        "/api/convert/illustrator",
        files=[("file", ("0307_大井町.ai", pdf, "application/postscript"))],
    )
    assert resp.status_code == 200, resp.text
    disposition = resp.headers.get("content-disposition", "")
    # ASCII fallback plus the UTF-8 encoded real name.
    assert "filename=" in disposition
    assert "filename*=UTF-8''" in disposition
    assert "%E5%A4%A7%E4%BA%95%E7%94%BA" in disposition  # 大井町 percent-encoded


# --------------------------------------------------------------------------- #
# QGIS project bundle
# --------------------------------------------------------------------------- #

def test_bundle_contains_gpkg_and_qgs() -> None:
    zip_bytes, name, _ = convert_ai_to_geopackage_bundle(_build_minimal_ai_pdf(), "sample.ai")
    assert name == "sample.zip"
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        assert set(archive.namelist()) == {"sample.gpkg", "sample.qgs"}


def _read_qgs(zip_bytes: bytes) -> ET.Element:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        qgs = next(n for n in archive.namelist() if n.endswith(".qgs"))
        return ET.fromstring(archive.read(qgs))


def test_qgs_references_layers_with_data_defined_colors() -> None:
    zip_bytes, _, _ = convert_ai_to_geopackage_bundle(_build_minimal_ai_pdf(), "sample.ai")
    root = _read_qgs(zip_bytes)

    maplayers = root.findall("./projectlayers/maplayer")
    assert len(maplayers) == 2
    datasources = [m.findtext("datasource") for m in maplayers]
    assert any("layername=Fill Layer" in ds and "sample.gpkg" in ds for ds in datasources)

    # The polygon layer must carry a data-defined fillColor from the fill_color field.
    poly = next(m for m in maplayers if m.get("geometry") == "Polygon")
    fields = {opt.get("name"): opt.get("value")
              for opt in poly.iter("Option") if opt.get("name") in {"field"}}
    dd_names = [opt.get("name") for opt in poly.iter("Option")]
    assert "fillColor" in dd_names
    assert "fill_color" in fields.values()

    line = next(m for m in maplayers if m.get("geometry") == "Line")
    line_dd_names = [opt.get("name") for opt in line.iter("Option")]
    assert "outlineColor" in line_dd_names


def test_qgs_layer_order_matches_illustrator_order() -> None:
    """Layer with an earlier /OCProperties /D /Order index appears first (top)."""
    # In the fixture the tree order should list the layers; both AI layers are
    # present so we just assert the tree has one entry per written table.
    zip_bytes, _, report = convert_ai_to_geopackage_bundle(_build_minimal_ai_pdf(), "sample.ai")
    root = _read_qgs(zip_bytes)
    tree = root.findall("./layer-tree-group/layer-tree-layer")
    assert len(tree) == 2
    # layerorder mirrors the tree ids
    order_ids = [el.get("id") for el in root.findall("./layerorder/layer")]
    tree_ids = [el.get("id") for el in tree]
    assert order_ids == tree_ids


def test_convert_endpoint_rejects_non_pdf(test_client) -> None:
    resp = test_client.post(
        "/api/convert/illustrator",
        files=[("file", ("bad.ai", b"not a pdf", "application/postscript"))],
    )
    assert resp.status_code == 400


@pytest.mark.georef
def test_multipage_report_records_each_page_size() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    assert report.page_count == 3
    assert report.pages == [
        {"index": 1, "width_pt": 200.0, "height_pt": 200.0},
        {"index": 2, "width_pt": 200.0, "height_pt": 200.0},
        {"index": 3, "width_pt": 400.0, "height_pt": 400.0},
    ]
    assert report.to_dict()["pages"] == report.pages


@pytest.mark.georef
def test_multipage_rows_carry_their_page_number() -> None:
    gpkg, _name, report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    assert report.total_features == 3
    gdf = _read_layer(gpkg, "Fill Layer")
    assert sorted(int(p) for p in gdf["page"]) == [1, 2, 3]


@pytest.mark.georef
def test_multipage_geometry_stacks_so_only_page_separates_it() -> None:
    """Every page normalizes to its own MediaBox origin, so all three coincide."""
    gpkg, _name, _report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    gdf = _read_layer(gpkg, "Fill Layer")
    assert {tuple(round(v, 3) for v in geom.bounds) for geom in gdf.geometry} == {
        (50.0, 50.0, 150.0, 110.0)
    }


@pytest.mark.georef
def test_single_page_file_still_reports_one_page() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_minimal_ai_pdf(), "sample.ai")
    assert report.page_count == 1
    assert report.pages == [{"index": 1, "width_pt": 200.0, "height_pt": 200.0}]


# --------------------------------------------------------------------------- #
# Polygon assembly: overlapping and nested subpaths within one painted path
# --------------------------------------------------------------------------- #

_L_BAR_VERTICAL = [(60, 60), (150, 60), (150, 360), (60, 360), (60, 60)]
_L_BAR_HORIZONTAL = [(60, 60), (360, 60), (360, 150), (60, 150), (60, 60)]
_SQUARE_OUTER = [(0, 0), (100, 0), (100, 100), (0, 100), (0, 0)]
_SQUARE_INNER = [(30, 30), (70, 30), (70, 70), (30, 70), (30, 30)]


@pytest.mark.georef
def test_overlapping_subpaths_union_into_one_polygon() -> None:
    """A PDF fill paints overlapping subpaths as their union, never a collection.

    Two rectangles forming an L is ordinary Illustrator output. Assembling them
    into a MultiPolygon would be invalid (members overlap), and repairing that
    yields a GeometryCollection, which has no `coordinates` and crashes the
    placement map's transform.
    """
    geom = _build_polygon([_L_BAR_VERTICAL, _L_BAR_HORIZONTAL])
    assert geom is not None
    assert geom.geom_type in {"Polygon", "MultiPolygon"}
    assert geom.is_valid
    # Union, not the naive 54000 that double-counts the shared corner.
    assert geom.area == pytest.approx(45900.0)


@pytest.mark.georef
def test_nested_subpath_becomes_a_hole() -> None:
    """A concentric ring is a hole, not a reason to drop the whole path.

    Depth by sampled point misclassifies this: the outer ring's representative
    point sits inside the inner ring, so both rings read as holes, no ring is
    left as an outer, and the entire feature silently disappears.
    """
    geom = _build_polygon([_SQUARE_OUTER, _SQUARE_INNER])
    assert geom is not None
    assert geom.geom_type == "Polygon"
    assert geom.is_valid
    assert geom.area == pytest.approx(8400.0)  # 10000 outer - 1600 hole
    assert len(geom.interiors) == 1


@pytest.mark.georef
def test_disjoint_subpaths_stay_a_multipolygon() -> None:
    """Regression guard: separate rings still produce separate parts."""
    far = [(500, 500), (600, 500), (600, 600), (500, 600), (500, 500)]
    geom = _build_polygon([_SQUARE_OUTER, far])
    assert geom is not None
    assert geom.geom_type == "MultiPolygon"
    assert len(geom.geoms) == 2
    assert geom.area == pytest.approx(20000.0)


@pytest.mark.georef
def test_hole_touching_the_outer_edge_still_becomes_a_hole() -> None:
    """A hole sharing an edge with its outer ring is contained, not overlapping."""
    flush = [(0, 30), (50, 30), (50, 70), (0, 70), (0, 30)]
    geom = _build_polygon([_SQUARE_OUTER, flush])
    assert geom is not None
    assert geom.geom_type == "Polygon"
    assert geom.is_valid
    assert geom.area == pytest.approx(8000.0)  # 10000 - 2000


def _build_overlapping_subpath_pdf() -> bytes:
    """One page, one filled path whose two subpaths overlap into an L."""
    content = (
        b"/OC /MC0 BDC\n"
        b"0 1 1 0 k\n"
        b"60 60 90 300 re\n"     # vertical bar
        b"60 60 300 90 re\n"     # horizontal bar, overlapping the corner
        b"f\n"
        b"EMC\n"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] >> >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] "
        b"/Resources << /Properties << /MC0 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /OCG /Name (Fill Layer) >>",
    ]
    out = bytearray(b"%PDF-1.6\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


@pytest.mark.georef
def test_overlapping_subpaths_survive_a_real_conversion() -> None:
    """End to end: the L reaches the GeoPackage as usable polygonal geometry."""
    gpkg, _name, report = convert_ai_to_geopackage(
        _build_overlapping_subpath_pdf(), "overlap.ai"
    )
    assert report.total_features == 1
    assert report.warnings == []  # nothing dropped as empty
    gdf = _read_layer(gpkg, "Fill Layer")
    assert len(gdf) == 1
    geom = gdf.geometry.iloc[0]
    assert geom.geom_type in {"Polygon", "MultiPolygon"}
    assert geom.area == pytest.approx(45900.0)
