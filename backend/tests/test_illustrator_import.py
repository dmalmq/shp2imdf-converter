"""Tests for the Illustrator (.ai / PDF) -> GeoPackage converter."""

from __future__ import annotations

import io
import math
import tempfile
import warnings
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import geopandas as gpd
import pytest

from backend.src.illustrator_importer import (
    IllustratorConversionError,
    _PathRecord,
    _align_pages,
    _build_polygon,
    _punch_page_overlaps,
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

    return _assemble_multipage_pdf(pages)


def _assemble_multipage_pdf(pages: list[tuple[bytes, bytes]]) -> bytes:
    """Assemble ``(mediabox, content stream)`` pairs into a one-layer PDF."""
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


def _build_offset_multipage_ai_pdf() -> bytes:
    """Three sheets: three agreeing plans, then one unrelated floor.

    Page 2 copies all three page-1 outlines at (+30, -20), providing independent
    support for one transform. Page 3 contains a different strip and must stay
    untouched. The border repeats identically on every sheet: matching it would
    claim a perfect fit and move nothing, which is exactly what the frame filter
    has to prevent.
    """
    def content(rects: list[tuple[int, int, int, int]]) -> bytes:
        body = b"/OC /MC0 BDC\n0 1 1 0 k\n"
        for x, y, w, h in rects:
            body += f"{x} {y} {w} {h} re\n".encode() + b"f\n"
        return body + b"EMC\n"

    sheet = b"[0 0 200 200]"
    return _assemble_multipage_pdf(
        [
            (
                sheet,
                content(
                    [
                        (0, 0, 200, 200),
                        (50, 50, 100, 60),
                        (20, 140, 40, 30),
                        (150, 100, 30, 70),
                    ]
                ),
            ),
            (
                sheet,
                content(
                    [
                        (0, 0, 200, 200),
                        (80, 30, 100, 60),
                        (50, 120, 40, 30),
                        (180, 80, 30, 70),
                    ]
                ),
            ),
            (sheet, content([(0, 0, 200, 200), (90, 10, 20, 180)])),
        ]
    )


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


def _alignment_by_page(report) -> dict[int, dict]:
    return {int(entry["page"]): entry for entry in report.page_alignment}


def _page_bounds(gpkg: bytes, page: int) -> set[tuple[float, ...]]:
    gdf = _read_layer(gpkg, "Fill Layer")
    return {
        tuple(round(value, 3) for value in geom.bounds)
        for geom in gdf[gdf["page"] == page].geometry
    }


def test_an_offset_page_is_shifted_onto_the_anchor_page() -> None:
    gpkg, _name, report = convert_ai_to_geopackage(_build_offset_multipage_ai_pdf(), "offset.ai")
    entry = _alignment_by_page(report)[2]
    assert entry["aligned"] is True
    assert entry["anchor_page"] == 1
    assert entry["offset"] == [-30.0, 20.0]
    assert entry["overlap_iou"] == pytest.approx(1.0)
    assert entry["rotation_deg"] == pytest.approx(0.0, abs=0.001)
    assert entry["scale"] == pytest.approx(1.0, abs=0.001)
    assert entry["matched_outlines"] == 3
    # The plan now sits where page 1 draws it, and the rest of the sheet came along.
    assert (50.0, 50.0, 150.0, 110.0) in _page_bounds(gpkg, 2)
    assert (-30.0, 20.0, 170.0, 220.0) in _page_bounds(gpkg, 2)


def test_a_page_whose_outline_differs_is_left_untouched() -> None:
    gpkg, _name, report = convert_ai_to_geopackage(_build_offset_multipage_ai_pdf(), "offset.ai")
    entry = _alignment_by_page(report)[3]
    assert entry["aligned"] is False
    assert entry["offset"] == [0.0, 0.0]
    assert entry["overlap_iou"] < 0.5
    assert _page_bounds(gpkg, 3) == {(0.0, 0.0, 200.0, 200.0), (90.0, 10.0, 110.0, 190.0)}


def test_single_page_artwork_reports_no_page_alignment() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_minimal_ai_pdf(), "sample.ai")
    assert report.page_alignment == []
    assert report.to_dict()["page_alignment"] == []


def test_one_outline_per_page_is_not_enough_to_move_artwork() -> None:
    _gpkg, _name, report = convert_ai_to_geopackage(_build_multipage_ai_pdf(), "three.ai")
    assert [entry["page"] for entry in report.page_alignment] == [2, 3]
    assert not any(entry["aligned"] for entry in report.page_alignment)
    assert {tuple(entry["offset"]) for entry in report.page_alignment} == {(0.0, 0.0)}


def _rect(x: float, y: float, w: float, h: float) -> list[tuple[float, float]]:
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def _outline_record(
    page: int,
    points: list[tuple[float, float]],
    *,
    role: str = "polygon",
    layer: str = "Plan",
    closed: bool = True,
) -> _PathRecord:
    subpath = [*points, points[0]] if closed else points
    return _PathRecord(
        page=page,
        layer=layer,
        role=role,
        subpaths=[subpath],
        fill_color="#ff0000" if role == "polygon" else None,
        stroke_color="#000000" if role == "line" else None,
        line_width=1.0,
        dashed=False,
    )


def _move_outline(
    points: list[tuple[float, float]],
    *,
    scale: float,
    rotation_deg: float,
    offset: tuple[float, float],
) -> list[tuple[float, float]]:
    theta = math.radians(rotation_deg)
    cosine, sine = math.cos(theta), math.sin(theta)
    return [
        (
            scale * (cosine * x - sine * y) + offset[0],
            scale * (sine * x + cosine * y) + offset[1],
        )
        for x, y in points
    ]


def _alignment_shapes() -> list[list[tuple[float, float]]]:
    return [
        [(20, 20), (100, 20), (100, 40), (55, 40), (55, 85), (20, 85)],
        [(245, 25), (325, 25), (325, 70), (295, 70), (295, 100), (245, 100)],
        [(145, 190), (220, 190), (220, 215), (185, 215), (185, 265), (145, 265)],
    ]


def test_multi_outline_consensus_recovers_rotation_scale_and_translation() -> None:
    shapes = _alignment_shapes()
    records: list[_PathRecord] = []
    for points in shapes:
        # Fill and stroke twins are the same evidence and must count once.
        records.extend(
            [
                _outline_record(1, points),
                _outline_record(1, points, role="line"),
            ]
        )
        moved = _move_outline(
            points,
            scale=1.02,
            rotation_deg=3.0,
            offset=(40.0, -25.0),
        )
        records.extend(
            [
                _outline_record(2, moved),
                _outline_record(2, moved, role="line"),
            ]
        )
    # This is larger than every real outline, but it is an open stroke. Closing
    # it would create the exact artificial-polygon bug from 0989_千葉.ai.
    records.extend(
        [
            _outline_record(
                1,
                [(0, 10), (390, 30), (360, 280), (10, 250)],
                role="line",
                closed=False,
                layer="Incidental",
            ),
            _outline_record(
                2,
                [(70, 0), (390, 80), (320, 290), (20, 210)],
                role="line",
                closed=False,
                layer="Incidental",
            ),
        ]
    )
    report = _align_pages(
        records,
        [
            {"index": 1, "width_pt": 400.0, "height_pt": 300.0},
            {"index": 2, "width_pt": 400.0, "height_pt": 300.0},
        ],
    )
    assert report[0]["aligned"] is True
    assert report[0]["matched_outlines"] == 3
    assert report[0]["scale"] == pytest.approx(1 / 1.02, rel=0.001)
    assert report[0]["rotation_deg"] == pytest.approx(-3.0, abs=0.01)
    # The exact unrounded matrix is applied to stored artwork, not the rounded report.
    source_first = records[2].subpaths[0][0]
    assert source_first == pytest.approx(shapes[0][0], abs=0.01)


def test_two_matching_outlines_are_insufficient_to_move_a_page() -> None:
    shapes = _alignment_shapes()[:2]
    records = [
        _outline_record(page, _move_outline(
            points,
            scale=1.0,
            rotation_deg=0.0,
            offset=(30.0, -20.0) if page == 2 else (0.0, 0.0),
        ))
        for page in (1, 2)
        for points in shapes
    ]
    before = records[2].subpaths[0][0]
    report = _align_pages(
        records,
        [
            {"index": 1, "width_pt": 400.0, "height_pt": 300.0},
            {"index": 2, "width_pt": 400.0, "height_pt": 300.0},
        ],
    )
    assert report[0]["aligned"] is False
    assert report[0]["offset"] == [0.0, 0.0]
    assert records[2].subpaths[0][0] == before


def _utf16be_ocg_name(text: str) -> bytes:
    return b"<FEFF" + text.encode("utf-16-be").hex().upper().encode("ascii") + b">"


def _oc_filled_rect(mc: str, x: int, y: int, w: int, h: int) -> bytes:
    return (
        f"/OC /{mc} BDC\n".encode()
        + b"0 1 1 0 k\n"
        + f"{x} {y} {w} {h} re\n".encode()
        + b"f\n"
        + b"EMC\n"
    )


def _build_punch_ai_pdf() -> bytes:
    """Two pages of nested ラチ内 / 建物 / エスカレーター fills.

    Page 2 uses a larger 建物 on the same artwork origin. Punching across pages
    would shrink page 1's ラチ内 below 6400.
    """
    content1 = (
        _oc_filled_rect("MC0", 0, 0, 100, 100)
        + _oc_filled_rect("MC1", 10, 10, 60, 60)
        + _oc_filled_rect("MC2", 20, 20, 10, 10)
    )
    content2 = (
        _oc_filled_rect("MC0", 0, 0, 100, 100)
        + _oc_filled_rect("MC1", 10, 10, 80, 80)
        + _oc_filled_rect("MC2", 20, 20, 10, 10)
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [3 0 R 4 0 R 5 0 R] "
        b"/D << /Order [3 0 R 4 0 R 5 0 R] >> >> >>",
        b"<< /Type /Pages /Kids [6 0 R 8 0 R] /Count 2 >>",
        b"<< /Type /OCG /Name " + _utf16be_ocg_name("在来線ラチ内") + b" >>",
        b"<< /Type /OCG /Name " + _utf16be_ocg_name("建物・施設") + b" >>",
        b"<< /Type /OCG /Name " + _utf16be_ocg_name("エスカレーター") + b" >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /Properties << /MC0 3 0 R /MC1 4 0 R /MC2 5 0 R >> >> "
        b"/Contents 7 0 R >>",
        b"<< /Length " + str(len(content1)).encode() + b" >>\nstream\n" + content1 + b"endstream",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /Properties << /MC0 3 0 R /MC1 4 0 R /MC2 5 0 R >> >> "
        b"/Contents 9 0 R >>",
        b"<< /Length " + str(len(content2)).encode() + b" >>\nstream\n" + content2 + b"endstream",
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
def test_nested_punch_subtracts_building_and_outer_escalator() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="コンコース連絡通路 ： 在来線ラチ内")
    building = _outline_record(1, _rect(10, 10, 60, 60), layer="建物・施設")
    esc_in = _outline_record(1, _rect(20, 20, 10, 10), layer="エスカレーター")
    esc_out = _outline_record(1, _rect(80, 80, 10, 10), layer="エスカレーター")
    shop = _outline_record(1, _rect(40, 40, 10, 10), layer="構内大型店舗 建物")
    midori = _outline_record(1, _rect(12, 12, 6, 6), layer="みどりの窓口・びゅうプラザ")
    original_building = _build_polygon(building.subpaths)
    original_esc_in = _build_polygon(esc_in.subpaths)
    original_shop = _build_polygon(shop.subpaths)
    original_midori = _build_polygon(midori.subpaths)
    assert original_building is not None
    assert original_esc_in is not None
    assert original_shop is not None
    assert original_midori is not None

    _punch_page_overlaps([rachi, building, esc_in, esc_out, shop, midori])

    punched_rachi = _build_polygon(rachi.subpaths)
    punched_building = _build_polygon(building.subpaths)
    assert punched_rachi is not None
    assert punched_building is not None
    assert punched_rachi.area == pytest.approx(6300.0)
    assert punched_building.area == pytest.approx(3364.0)
    assert punched_rachi.covers(punched_building) is False
    assert punched_rachi.intersection(original_building).area == pytest.approx(0.0)
    assert punched_building.intersection(original_esc_in).area == pytest.approx(0.0)
    assert punched_building.intersection(original_shop).area == pytest.approx(0.0)
    assert punched_building.intersection(original_midori).area == pytest.approx(0.0)


@pytest.mark.georef
def test_punch_uses_original_building_so_shop_stays_cut_from_concourse() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    building = _outline_record(1, _rect(10, 10, 60, 60), layer="建物・施設")
    shop = _outline_record(1, _rect(40, 40, 10, 10), layer="構内大型店舗")
    _punch_page_overlaps([rachi, building, shop])
    punched_rachi = _build_polygon(rachi.subpaths)
    assert punched_rachi is not None
    assert punched_rachi.area == pytest.approx(6400.0)


@pytest.mark.georef
def test_punch_stays_on_the_same_pdf_page() -> None:
    rachi1 = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    building1 = _outline_record(1, _rect(10, 10, 60, 60), layer="建物・施設")
    poison1 = _outline_record(1, _rect(270, 270, 20, 20), layer="建物・施設")
    rachi2 = _outline_record(2, _rect(200, 200, 100, 100), layer="在来線ラチ内")
    building2 = _outline_record(2, _rect(210, 210, 40, 40), layer="建物・施設")
    poison2 = _outline_record(2, _rect(70, 70, 20, 20), layer="建物・施設")
    _punch_page_overlaps([rachi1, building1, poison1, rachi2, building2, poison2])
    assert _build_polygon(rachi1.subpaths).area == pytest.approx(6400.0)
    assert _build_polygon(rachi2.subpaths).area == pytest.approx(8400.0)


@pytest.mark.georef
def test_shinkansen_concourse_is_not_punched() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="新幹線ラチ内")
    building = _outline_record(1, _rect(10, 10, 60, 60), layer="建物・施設")
    _punch_page_overlaps([rachi, building])
    assert _build_polygon(rachi.subpaths).area == pytest.approx(10000.0)


@pytest.mark.georef
def test_other_line_is_not_a_cutter() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    other = _outline_record(1, _rect(10, 10, 60, 60), layer="その他線")
    _punch_page_overlaps([rachi, other])
    assert _build_polygon(rachi.subpaths).area == pytest.approx(10000.0)


@pytest.mark.georef
def test_line_records_do_not_punch_or_get_punched() -> None:
    building = _outline_record(1, _rect(10, 10, 60, 60), layer="建物・施設")
    line_esc = _outline_record(
        1,
        [(15, 15), (55, 55)],
        role="line",
        layer="エスカレーター",
        closed=False,
    )
    poly_esc = _outline_record(1, _rect(20, 20, 10, 10), layer="エスカレーター")
    line_before = [list(pts) for pts in line_esc.subpaths]
    _punch_page_overlaps([building, line_esc, poly_esc])
    assert line_esc.subpaths == line_before
    assert _build_polygon(building.subpaths).area == pytest.approx(3500.0)


@pytest.mark.georef
def test_empty_cutters_leave_concourse_unchanged() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    _punch_page_overlaps([rachi])
    assert _build_polygon(rachi.subpaths).area == pytest.approx(10000.0)


@pytest.mark.georef
def test_fully_covered_concourse_is_dropped() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    building = _outline_record(1, _rect(0, 0, 100, 100), layer="建物・施設")
    _punch_page_overlaps([rachi, building])
    assert rachi.subpaths == []
    assert _build_polygon(rachi.subpaths) is None
    assert _build_polygon(building.subpaths).area == pytest.approx(10000.0)


@pytest.mark.georef
def test_cutter_crossing_an_edge_leaves_a_notch() -> None:
    rachi = _outline_record(1, _rect(0, 0, 100, 100), layer="在来線ラチ内")
    building = _outline_record(1, _rect(90, 40, 20, 20), layer="建物・施設")
    _punch_page_overlaps([rachi, building])
    punched = _build_polygon(rachi.subpaths)
    assert punched is not None
    assert punched.is_empty is False
    assert punched.area == pytest.approx(9800.0)


@pytest.mark.georef
def test_convert_writes_punched_polygons_into_the_geopackage() -> None:
    import fiona

    gpkg, _name, report = convert_ai_to_geopackage(_build_punch_ai_pdf(), "punch.ai")
    assert report.page_count == 2
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "punch.gpkg"
        path.write_bytes(gpkg)
        layers = set(fiona.listlayers(path))
    assert "在来線ラチ内" in layers
    assert "建物・施設" in layers
    assert "エスカレーター" in layers

    rachi = _read_layer(gpkg, "在来線ラチ内")
    building = _read_layer(gpkg, "建物・施設")
    escalator = _read_layer(gpkg, "エスカレーター")
    page1_rachi = rachi[rachi["page"] == 1].geometry.iloc[0]
    page2_rachi = rachi[rachi["page"] == 2].geometry.iloc[0]
    page1_building = building[building["page"] == 1].geometry.iloc[0]
    page1_escalator = escalator[escalator["page"] == 1].geometry.iloc[0]
    assert page1_rachi.area == pytest.approx(6400.0)
    assert page2_rachi.area == pytest.approx(3600.0)
    assert page1_building.covers(page1_escalator) is False
    assert page1_building.intersection(page1_escalator).area == pytest.approx(0.0)
