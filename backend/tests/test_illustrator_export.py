"""Preview construction and georeferenced export."""

from __future__ import annotations

import io
import json
import math
import sqlite3
import re
import zipfile
from pathlib import Path

import geopandas as gpd
import pytest

from backend.src.illustrator_export import (
    ExportFloor,
    ExportFormats,
    build_georeferenced_bundle,
    build_preview,
    compute_assignment_summary,
)
from backend.src.illustrator_georeference import SimilarityTransform, project_point
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionStore
from backend.tests.test_illustrator_import import (
    _build_minimal_ai_pdf,
    _build_multipage_ai_pdf,
)

ANCHOR_LON = 139.700258
ANCHOR_LAT = 35.690921
COVER_ALL = [-1e9, -1e9, 1e9, 1e9]


@pytest.fixture()
def cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))


@pytest.fixture()
def multipage_cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path / "mp", ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_multipage_ai_pdf(), "three.ai"))


def _transform(cached) -> SimilarityTransform:
    bounds = build_preview(cached)["artwork_bounds"]
    return SimilarityTransform(
        artwork_anchor=((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2),
        map_anchor=(ANCHOR_LON, ANCHOR_LAT),
        rotation_deg=0.0,
        metres_per_point=0.176389,
        working_crs="EPSG:6677",
    )


def _transform_at(rotation: float = 0.0, anchor=(ANCHOR_LON, ANCHOR_LAT)) -> SimilarityTransform:
    return SimilarityTransform(
        artwork_anchor=(85.0, 80.0),  # fixture artwork bbox centre
        map_anchor=anchor,
        rotation_deg=rotation,
        metres_per_point=0.176389,
        working_crs="EPSG:6677",
    )


def _one_floor(cached, transform: SimilarityTransform | None = None) -> list[ExportFloor]:
    """The implicit single floor: one label covering the whole artwork."""
    return [ExportFloor("artwork", transform or _transform(cached), COVER_ALL, None)]


def _iter_coords(geometry):
    def walk(node):
        if isinstance(node, (list, tuple)):
            if node and isinstance(node[0], (int, float)):
                yield float(node[0]), float(node[1])
            else:
                for child in node:
                    yield from walk(child)

    yield from walk(geometry["coordinates"])


def _extract(payload: bytes, suffix: str, destination: Path) -> Path:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        name = next(n for n in archive.namelist() if n.endswith(suffix))
        destination.write_bytes(archive.read(name))
    return destination


@pytest.mark.georef
def test_preview_reports_bounds_and_counts(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    assert maxx > minx and maxy > miny
    assert preview["total_features"] >= 1
    assert preview["preview_features"] <= preview["total_features"]
    assert preview["preview"]["type"] == "FeatureCollection"


@pytest.mark.georef
def test_preview_features_carry_layer_and_colour_properties(cached) -> None:
    feature = build_preview(cached)["preview"]["features"][0]
    assert set(feature["properties"]) >= {"ai_layer", "role", "fill_color", "stroke_color"}


@pytest.mark.georef
def test_preview_coordinates_stay_in_artwork_points(cached) -> None:
    preview = build_preview(cached)
    minx, miny, maxx, maxy = preview["artwork_bounds"]
    for feature in preview["preview"]["features"]:
        for x, y in _iter_coords(feature["geometry"]):
            assert minx - 1 <= x <= maxx + 1
            assert miny - 1 <= y <= maxy + 1


@pytest.mark.georef
def test_preview_layer_summaries_match_the_written_tables(cached) -> None:
    summaries = build_preview(cached)["layers"]
    assert {s["table"] for s in summaries} == {s["table"] for s in cached.written_layers}
    assert all(s["feature_count"] >= 0 for s in summaries)


@pytest.mark.georef
def test_export_places_the_anchor_at_the_requested_location(cached, tmp_path: Path) -> None:
    """The union bbox centre lands on the anchor (its own defining point)."""
    payload, filename = build_georeferenced_bundle(
        cached, _one_floor(cached), "EPSG:6677", ExportFormats()
    )
    assert filename.endswith(".zip")

    gpkg = _extract(payload, ".gpkg", tmp_path / "out.gpkg")
    bounds = None
    first_crs = None
    for spec in cached.written_layers:
        gdf = gpd.read_file(gpkg, layer=f"artwork_{spec['table']}")
        first_crs = first_crs or gdf.crs
        minx, miny, maxx, maxy = gdf.total_bounds
        bounds = (
            [minx, miny, maxx, maxy]
            if bounds is None
            else [
                min(bounds[0], minx),
                min(bounds[1], miny),
                max(bounds[2], maxx),
                max(bounds[3], maxy),
            ]
        )
    expected = project_point(ANCHOR_LON, ANCHOR_LAT, "EPSG:6677")
    assert math.dist(((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2), expected) < 1.0
    assert first_crs.to_epsg() == 6677


@pytest.mark.georef
def test_export_contains_every_requested_format(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _one_floor(cached), "EPSG:6677", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
    for suffix in (".shp", ".prj", ".dbf", ".shx"):
        assert any(n.endswith(suffix) for n in names), suffix


@pytest.mark.georef
def test_export_honours_format_selection(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        _one_floor(cached),
        "EPSG:6677",
        ExportFormats(geopackage=True, shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert not any(n.endswith(".shp") for n in names)
    assert not any(n.endswith(".qgs") for n in names)


@pytest.mark.georef
def test_prj_declares_the_output_crs(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _one_floor(cached), "EPSG:4326", ExportFormats()
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        prj = next(n for n in archive.namelist() if n.endswith(".prj"))
        text = archive.read(prj).decode("utf-8", "replace")
    assert "WGS" in text.upper() or "4326" in text


@pytest.mark.georef
def test_reprojection_to_4326_yields_plausible_lonlat(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached, _one_floor(cached), "EPSG:4326", ExportFormats(shapefile=False, qgis=False)
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "reproj.gpkg")
    gdf = gpd.read_file(gpkg, layer=f"artwork_{cached.written_layers[0]['table']}")
    minx, miny, maxx, maxy = gdf.total_bounds
    assert 139.6 < (minx + maxx) / 2 < 139.8
    assert 35.6 < (miny + maxy) / 2 < 35.8


@pytest.mark.georef
def test_rotation_changes_the_footprint_but_not_its_area(cached, tmp_path: Path) -> None:
    upright = _transform(cached)
    turned = _transform(cached)
    turned.rotation_deg = 45.0

    areas = []
    for index, transform in enumerate((upright, turned)):
        payload, _ = build_georeferenced_bundle(
            cached, _one_floor(cached, transform), "EPSG:6677", ExportFormats(shapefile=False, qgis=False)
        )
        gpkg = _extract(payload, ".gpkg", tmp_path / f"rot{index}.gpkg")
        gdf = gpd.read_file(gpkg, layer=f"artwork_{cached.written_layers[0]['table']}")
        areas.append(float(gdf.geometry.area.sum()))
    assert areas[0] == pytest.approx(areas[1], rel=1e-9)


@pytest.mark.georef
def test_export_rejects_a_non_positive_scale(cached) -> None:
    transform = _transform(cached)
    transform.metres_per_point = 0.0
    with pytest.raises(ValueError):
        build_georeferenced_bundle(cached, _one_floor(cached, transform), "EPSG:6677", ExportFormats())


# --------------------------------------------------------------------------- #
# Multi-floor behaviour
#
# Fixture geometry (verified): "線路" line bounds [20,20]-[120,140] centroid
# (70,80); "Fill Layer" polygon bounds [50,50]-[150,110] centroid (100,80).
# A vertical split at x=85 separates them.
# --------------------------------------------------------------------------- #

BOX_1F = [0.0, 0.0, 85.0, 200.0]    # the line's side
BOX_2F = [85.0, 0.0, 200.0, 200.0]  # the polygon's side


@pytest.mark.georef
def test_assignment_summary_counts_centroids_in_boxes(cached) -> None:
    floors, unassigned = compute_assignment_summary(
        cached, [ExportFloor("1F", _transform_at(), COVER_ALL, None)]
    )
    assert floors[0]["feature_count"] == cached.report["total_features"]
    assert unassigned == 0
    assert floors[0]["artwork_bounds"][0] >= 0


@pytest.mark.georef
def test_assignment_summary_counts_unassigned_features(cached) -> None:
    floors, unassigned = compute_assignment_summary(
        cached, [ExportFloor("1F", _transform_at(), [0.0, 0.0, 90.0, 200.0], None)]
    )
    assert floors[0]["feature_count"] == 1
    assert unassigned == 1


@pytest.mark.georef
def test_assignment_summary_layer_restriction(cached) -> None:
    restricted = ExportFloor("1F", _transform_at(), COVER_ALL, ["Fill Layer"])
    floors, unassigned = compute_assignment_summary(cached, [restricted])
    assert {row["ai_layer"] for row in floors[0]["layer_counts"]} == {"Fill Layer"}
    assert unassigned == 1


@pytest.mark.georef
def test_export_materializes_per_floor_tables(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        [ExportFloor("1F", _transform_at(), COVER_ALL, None)],
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "mf.gpkg")
    expected = {f"1F_{spec['table']}" for spec in cached.written_layers}
    for table in expected:
        gdf = gpd.read_file(gpkg, layer=table)
        assert (gdf["floor"] == "1F").all()
    with sqlite3.connect(gpkg) as conn:
        actual = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert expected <= actual


@pytest.mark.georef
def test_two_floors_split_the_artwork(cached, tmp_path: Path) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        [
            ExportFloor("1F", _transform_at(), BOX_1F, None),
            ExportFloor("2F", _transform_at(), BOX_2F, None),
        ],
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "split.gpkg")
    with sqlite3.connect(gpkg) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "1F_線路__lines" in tables
    assert "2F_Fill Layer" in tables
    assert "2F_線路__lines" not in tables
    assert "1F_Fill Layer" not in tables


@pytest.mark.georef
def test_export_applies_each_floors_own_transform(cached, tmp_path: Path) -> None:
    shifted = _transform_at(anchor=(139.701, 35.6915))  # well north-east of ANCHOR
    payload, _ = build_georeferenced_bundle(
        cached,
        [
            ExportFloor("1F", _transform_at(), BOX_1F, None),
            ExportFloor("2F", shifted, BOX_2F, None),
        ],
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "twoplace.gpkg")
    line = gpd.read_file(gpkg, layer="1F_線路__lines")
    polygon = gpd.read_file(gpkg, layer="2F_Fill Layer")
    assert polygon.total_bounds[0] > line.total_bounds[0]
    assert polygon.total_bounds[1] > line.total_bounds[1]


@pytest.mark.georef
def test_export_report_counts_floors_and_unassigned(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        [ExportFloor("1F", _transform_at(), [0.0, 0.0, 90.0, 200.0], None)],
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
    assert report["floors"][0]["label"] == "1F"
    assert report["floors"][0]["feature_count"] == 1
    assert report["unassigned_count"] == 1
    assert any("Fill Layer" in warning for warning in report["warnings"])


@pytest.mark.georef
def test_export_report_warns_for_a_fully_unassigned_layer(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        [ExportFloor("1F", _transform_at(), BOX_2F, None)],  # only the polygon's side
        "EPSG:6677",
        ExportFormats(shapefile=False, qgis=False),
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        report = json.loads(archive.read("export_report.json").decode("utf-8"))
    assert report["unassigned_count"] == 1
    assert any("線路" in warning for warning in report["warnings"])


@pytest.mark.georef
def test_export_rejects_empty_floors(cached) -> None:
    with pytest.raises(Exception):
        build_georeferenced_bundle(cached, [], "EPSG:6677", ExportFormats())


@pytest.mark.georef
def test_qgs_groups_layers_by_floor(cached) -> None:
    payload, _ = build_georeferenced_bundle(
        cached,
        [
            ExportFloor("1F", _transform_at(), BOX_1F, None),
            ExportFloor("2F", _transform_at(), BOX_2F, None),
        ],
        "EPSG:6677",
        ExportFormats(shapefile=False),  # geopackage + qgis
    )
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        xml = archive.read(next(n for n in archive.namelist() if n.endswith(".qgs"))).decode("utf-8")
    assert xml.count('<layer-tree-group expanded="1" name="1F">') == 1
    assert xml.count('<layer-tree-group expanded="1" name="2F">') == 1
    assert "|layername=1F_線路__lines" in xml
    assert "|layername=2F_Fill Layer" in xml


@pytest.mark.georef
def test_preview_lists_every_page_with_its_sheet_size(multipage_cached) -> None:
    pages = build_preview(multipage_cached)["pages"]
    assert [p["index"] for p in pages] == [1, 2, 3]
    assert [(p["width_pt"], p["height_pt"]) for p in pages] == [
        (200.0, 200.0),
        (200.0, 200.0),
        (400.0, 400.0),
    ]


@pytest.mark.georef
def test_preview_reports_per_page_bounds_and_counts(multipage_cached) -> None:
    pages = build_preview(multipage_cached)["pages"]
    for page in pages:
        assert page["feature_count"] == 1
        # All three rectangles normalize to the same artwork coordinates.
        assert [round(v, 3) for v in page["bounds"]] == [50.0, 50.0, 150.0, 110.0]


@pytest.mark.georef
def test_preview_features_carry_their_page(multipage_cached) -> None:
    preview = build_preview(multipage_cached)["preview"]
    assert sorted(f["properties"]["page"] for f in preview["features"]) == [1, 2, 3]


@pytest.mark.georef
def test_page_only_floor_takes_that_whole_page(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), pages=[1])],
    )
    assert floors[0]["feature_count"] == 1
    assert unassigned == 2


@pytest.mark.georef
def test_two_pages_merge_under_one_label(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), pages=[1, 3])],
    )
    assert len(floors) == 1
    assert floors[0]["feature_count"] == 2
    assert unassigned == 1


@pytest.mark.georef
def test_excluded_page_is_counted_as_unassigned(multipage_cached) -> None:
    floors, unassigned = compute_assignment_summary(
        multipage_cached,
        [
            ExportFloor("1F", _transform_at(), pages=[1]),
            ExportFloor("2F", _transform_at(), pages=[2]),
        ],
    )
    assert {f["label"] for f in floors} == {"1F", "2F"}
    assert unassigned == 1  # page 3 claimed by nobody


@pytest.mark.georef
def test_page_and_box_combine(multipage_cached) -> None:
    """The drill-in case: a box scoped to one page."""
    inside, _ = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), region=[0, 0, 200, 200], pages=[1])],
    )
    assert inside[0]["feature_count"] == 1

    outside, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), region=[300, 300, 400, 400], pages=[1])],
    )
    assert outside == []
    assert unassigned == 3


@pytest.mark.georef
def test_page_and_layer_restriction_combine(multipage_cached) -> None:
    matched, _ = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), layer_names=["Fill Layer"], pages=[2])],
    )
    assert matched[0]["feature_count"] == 1

    missed, unassigned = compute_assignment_summary(
        multipage_cached,
        [ExportFloor("1F", _transform_at(), layer_names=["no such layer"], pages=[2])],
    )
    assert missed == []
    assert unassigned == 3


@pytest.mark.georef
def test_all_null_floor_claims_everything(multipage_cached) -> None:
    """The implicit whole-artwork floor: no page, box or layer restriction."""
    floors, unassigned = compute_assignment_summary(
        multipage_cached, [ExportFloor("artwork", _transform_at())]
    )
    assert floors[0]["feature_count"] == 3
    assert unassigned == 0


@pytest.mark.georef
def test_export_applies_each_page_floors_own_transform(
    multipage_cached, tmp_path: Path
) -> None:
    payload, _ = build_georeferenced_bundle(
        multipage_cached,
        [
            ExportFloor("1F", _transform_at(anchor=(ANCHOR_LON, ANCHOR_LAT)), pages=[1]),
            ExportFloor("2F", _transform_at(anchor=(ANCHOR_LON + 0.01, ANCHOR_LAT)), pages=[2]),
        ],
        "EPSG:4326",
        ExportFormats(shapefile=False, qgis=False),
    )
    gpkg = _extract(payload, ".gpkg", tmp_path / "pages.gpkg")
    first = gpd.read_file(gpkg, layer="1F_Fill Layer")
    second = gpd.read_file(gpkg, layer="2F_Fill Layer")
    assert (first["floor"] == "1F").all()
    assert (second["floor"] == "2F").all()
    # Same artwork coordinates, different map anchors -> different longitudes.
    assert second.geometry.iloc[0].centroid.x > first.geometry.iloc[0].centroid.x


@pytest.mark.georef
def test_preview_of_a_single_page_file_lists_one_page(cached) -> None:
    preview = build_preview(cached)
    assert [p["index"] for p in preview["pages"]] == [1]
    assert preview["pages"][0]["feature_count"] == preview["total_features"]
    assert preview["pages"][0]["bounds"] == preview["artwork_bounds"]


@pytest.mark.georef
def test_read_layers_backfills_page_for_older_caches(cached) -> None:
    """A conversion cached before per-page tagging is treated as single-page.

    Simulates the old cache by dropping the column from the GeoPackage on disk,
    which is what an entry written by the previous version actually looks like.
    """
    from backend.src.illustrator_export import _read_layers

    with sqlite3.connect(cached.gpkg_path) as conn:
        for spec in cached.written_layers:
            conn.execute(f'ALTER TABLE "{spec["table"]}" DROP COLUMN page')

    for _spec, gdf in _read_layers(cached):
        assert "page" in gdf.columns
        assert set(gdf["page"]) == {1}


@pytest.mark.georef
def test_preview_of_a_cache_without_page_metadata_lists_one_page(cached) -> None:
    """An old cache has no report['pages'] either; the grid still gets a page."""
    cached.report.pop("pages", None)
    pages = build_preview(cached)["pages"]
    assert [p["index"] for p in pages] == [1]
    assert pages[0]["bounds"] == build_preview(cached)["artwork_bounds"]


# --------------------------------------------------------------------------- #
# QGIS layer tree: one group per floor, layers in Illustrator stack order
# --------------------------------------------------------------------------- #

def _build_two_layer_two_page_pdf() -> bytes:
    """Two pages, each carrying BOTH layers, so every layer spans every floor.

    This is the ordinary case for a station drawing and the one the previous
    fixtures could not express: `BOX_1F`/`BOX_2F` are disjoint, so each layer
    landed on exactly one floor and the per-(layer, floor) grouping bug stayed
    invisible.

    The OCG stack is `[zzz, aaa]` (zzz on top) while alphabetical order is the
    reverse, so the layer ordering inside a group is observable.
    """
    def content() -> bytes:
        return (
            b"/OC /MC0 BDC\n0 1 1 0 k\n10 10 60 60 re\nf\nEMC\n"
            b"/OC /MC1 BDC\n1 1 0 0 k\n90 90 60 60 re\nf\nEMC\n"
        )

    objects: list[bytes | None] = [
        b"<< /Type /Catalog /Pages 2 0 R "
        b"/OCProperties << /OCGs [3 0 R 4 0 R] /D << /Order [3 0 R 4 0 R] >> >> >>",
        None,
        b"<< /Type /OCG /Name (zzz) >>",
        b"<< /Type /OCG /Name (aaa) >>",
    ]
    page_ids: list[int] = []
    for _ in range(2):
        stream = content()
        page_id = len(objects) + 1
        stream_id = len(objects) + 2
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
            b"/Resources << /Properties << /MC0 3 0 R /MC1 4 0 R >> >> /Contents "
            + str(stream_id).encode() + b" 0 R >>"
        )
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream"
        )
        page_ids.append(page_id)
    kids = b" ".join(f"{i} 0 R".encode() for i in page_ids)
    objects[1] = b"<< /Type /Pages /Kids [" + kids + b"] /Count 2 >>"

    out = bytearray(b"%PDF-1.6\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        assert body is not None
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    n = len(objects) + 1
    out += f"xref\n0 {n}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture()
def shared_layer_cached(tmp_path: Path):
    store = ConversionStore(root=tmp_path / "shared", ttl_seconds=3600, max_entries=5)
    return store.put(parse_ai(_build_two_layer_two_page_pdf(), "shared.ai"))


def _qgs_of(payload: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return archive.read(
            next(n for n in archive.namelist() if n.endswith(".qgs"))
        ).decode("utf-8")


def _page_floors() -> list[ExportFloor]:
    return [
        ExportFloor("1F", _transform_at(), pages=[1]),
        ExportFloor("2F", _transform_at(), pages=[2]),
    ]


@pytest.mark.georef
def test_qgs_emits_one_group_per_floor_when_layers_span_floors(shared_layer_cached) -> None:
    """A layer on several floors must not split the tree into per-layer groups.

    The export loop is layer-major, so each floor recurs non-adjacently; grouping
    by consecutive run produced one single-layer group per (layer, floor) pair.
    """
    payload, _ = build_georeferenced_bundle(
        shared_layer_cached, _page_floors(), "EPSG:6677", ExportFormats(shapefile=False)
    )
    xml = _qgs_of(payload)
    assert xml.count("<layer-tree-group ") == 2
    assert xml.count('name="1F">') == 1
    assert xml.count('name="2F">') == 1


@pytest.mark.georef
def test_qgs_group_holds_every_layer_of_its_floor(shared_layer_cached) -> None:
    groups = re.findall(
        r'<layer-tree-group expanded="1" name="(\w+)">(.*?)</layer-tree-group>',
        _qgs_of(
            build_georeferenced_bundle(
                shared_layer_cached, _page_floors(), "EPSG:6677",
                ExportFormats(shapefile=False),
            )[0]
        ),
        re.DOTALL,
    )
    assert [name for name, _ in groups] == ["1F", "2F"]
    for _name, body in groups:
        assert body.count("<layer-tree-layer") == 2


@pytest.mark.georef
def test_qgs_orders_layers_within_a_group_by_the_illustrator_stack(
    shared_layer_cached,
) -> None:
    """`zzz` is top of the OCG stack, so it must precede `aaa` despite sorting later."""
    assert shared_layer_cached.layer_order == ["zzz", "aaa"]
    xml = _qgs_of(
        build_georeferenced_bundle(
            shared_layer_cached, _page_floors(), "EPSG:6677",
            ExportFormats(shapefile=False),
        )[0]
    )
    first_group = re.search(
        r'name="1F">(.*?)</layer-tree-group>', xml, re.DOTALL
    ).group(1)
    names = re.findall(r'name="1F / (\w+)"', first_group)
    assert names == ["zzz", "aaa"]


@pytest.mark.georef
def test_qgs_group_order_follows_the_requested_floor_order(shared_layer_cached) -> None:
    """Floor order is the request order, not whichever floor a layer first hit."""
    reversed_floors = [
        ExportFloor("2F", _transform_at(), pages=[2]),
        ExportFloor("1F", _transform_at(), pages=[1]),
    ]
    xml = _qgs_of(
        build_georeferenced_bundle(
            shared_layer_cached, reversed_floors, "EPSG:6677",
            ExportFormats(shapefile=False),
        )[0]
    )
    assert re.findall(r'<layer-tree-group expanded="1" name="(\w+)">', xml) == ["2F", "1F"]
