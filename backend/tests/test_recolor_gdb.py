"""Recolouring a File Geodatabase: the right values in place, nothing else moved, indexes intact, a second run a no-op.

The geodatabase is built and read back through ``gdb_fixture_tool.py`` in the
interpreter ``find_gdal_python`` finds. Tests that need one skip without it;
the tests of what happens without one always run.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import shutil

import pytest

from backend.src.color_theme import ColorTheme, load_color_theme
from backend.src.dbf_table import DbfTable
from backend.src.gdb import find_gdal_python, read_layers
from backend.src.recolor import Archive, Inspection, convert, inspect
from backend.tests.color_theme_fixtures import make_zip, read_zip, station_members
from backend.tests.gdb_fixtures import build_gdb, dump_gdb, filter_fids, fingerprint, gdb_files, space

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 64 * 1024 * 1024
GDAL_PYTHON = find_gdal_python()
GDB = "DemoSta_3857.gdb"

pytestmark = pytest.mark.colortheme
needs_gdal = pytest.mark.skipif(GDAL_PYTHON is None, reason="no Python with GDAL's osgeo; set GDB_GDAL_PYTHON")

# The Figma table again, typed out apart from the config: (old, category) -> the value the row must end with.
EVERY_RULE = {
    ("黄", "B999"): "在来線改札内",
    ("橙", "B999"): "新幹線改札内",
    ("緑", "B999"): "新幹線改札内",
    ("ラチ外白", "B999"): "改札外通路",
    ("薄紅", "B028"): "在来線改札内",
    ("濃紅", "B028"): "新幹線改札内",
    ("薄空", "B001"): "施設",
    ("濃空", "B001"): "施設",
    ("薄鼠", "B022"): "進入制限エリア",
    ("白", "B021"): "階段・エスカレーター",
    ("トイレ", "B008"): "施設",
    ("濃鼠", "B999"): "改札外通路",
    ("濃鼠", "B008"): "施設",
    ("道白", "B029"): "改札外通路",
    ("進入制限あり", "B999"): "進入制限エリア",
}
KEPT = [("施設", "B001"), ("", "B019"), (None, None), ("赤", "B019")]
FLOOR_1 = [*EVERY_RULE, *KEPT]
FLOOR_1_AFTER = [*EVERY_RULE.values(), "施設", "", None, "赤"]
NARROW = [("白", "B021"), ("黄", "B999"), ("薄鼠", "B022")]
JAPANESE = [("ラチ外白", "B999"), ("トイレ", "B008")]
TOO_NARROW = [("白", "B021"), ("黄", "B999")]
ALREADY_NEW = [("施設", "B001"), ("改札外通路", "B999")]
# A floor with a room drawn as a second clockwise ring inside it: two filled parts to ArcGIS, not a hole.
NESTED_PARTS = "MULTIPOLYGON ZM (((0 0 1 0,0 100 1 0,100 100 1 0,100 0 1 0,0 0 1 0)),((10 10 1 0,10 20 1 0,20 20 1 0,20 10 1 0,10 10 1 0)))"
WITH_HOLE = "POLYGON ZM ((200 0 1 0,200 100 1 0,300 100 1 0,300 0 1 0,200 0 1 0),(210 10 1 0,220 10 1 0,220 20 1 0,210 20 1 0,210 10 1 0))"
RINGS = space("DemoSta_4_Space", [("薄鼠", "B022"), ("白", "B021")], width=12)
RINGS["rows"][0]["wkt"], RINGS["rows"][1]["wkt"] = NESTED_PARTS, WITH_HOLE
CLASSES = [
    space("DemoSta_1_Space", FLOOR_1, width=254),
    space("DemoSta_B1_Space", NARROW, width=12),
    space("G空間_0_Space", JAPANESE, width=12),
    space("DemoSta_2_Space", TOO_NARROW, width=8, dataset=None),
    space("DemoSta_3_Space", ALREADY_NEW, width=12),
    RINGS,
    {"name": "DemoSta_1_Facility", "dataset": "Station", "fields": [["name", 20]], "rows": [{"name": "gate"}, {"name": "lift"}]},
]
EDITED = ("DemoSta_1_Space", "DemoSta_B1_Space", "G空間_0_Space", "DemoSta_2_Space", "DemoSta_4_Space")
LOCKS = [
    (f"{GDB}/_gdb.CL201902004.21204.26768.sr.lock", b""),
    (f"{GDB}/DemoSta_1_Space.CL201902004.21204.26768.sr.lock", b""),
    (f"{GDB}/無料シャトルバス.CL202405004.13112.44100.sr.lock", b""),
]


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


@dataclass(frozen=True)
class Converted:
    pristine: Path
    upload: list[tuple[str, bytes]]
    inspection: Inspection
    archive: Archive
    output: dict[str, bytes | None]
    result: Path
    before: dict
    after: dict


def _unpack(output: dict[str, bytes | None], prefix: str, target: Path) -> Path:
    target.mkdir(parents=True)
    for name, data in output.items():
        if data is not None and name.startswith(prefix):
            (target / name.removeprefix(prefix)).write_bytes(data)
    return target


@pytest.fixture(scope="module")
def converted(theme: ColorTheme, tmp_path_factory: pytest.TempPathFactory) -> Converted:
    """One zipped station converted once; the tests read different parts of the same result."""
    root = tmp_path_factory.mktemp("gdb")
    pristine = build_gdb(root / GDB, CLASSES, GDAL_PYTHON)
    upload = [("DemoSta_3857.zip", make_zip([(f"{GDB}/", None), *gdb_files(pristine, GDB), *LOCKS]))]
    inspection = inspect(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)
    archive = convert(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)
    output = read_zip(archive.data)
    result = _unpack(output, f"{GDB}/", root / "out" / GDB)
    return Converted(
        pristine=pristine,
        upload=upload,
        inspection=inspection,
        archive=archive,
        output=output,
        result=result,
        before=dump_gdb(pristine, GDAL_PYTHON),
        after=dump_gdb(result, GDAL_PYTHON),
    )


def _color2(dump: dict, layer: str) -> list[str | None]:
    return [row["fields"]["color2"] for row in dump["layers"][layer]["rows"]]


@needs_gdal
def test_every_rule_rewrites_its_rows_inside_the_geodatabase(converted: Converted) -> None:
    report = converted.inspection.theme

    assert _color2(converted.after, "DemoSta_1_Space") == FLOOR_1_AFTER
    rows = {(line.old, line.categories is not None): line.rows for line in report.rules}
    assert rows == {
        ("黄", False): 3,
        ("橙", False): 1,
        ("緑", False): 1,
        ("ラチ外白", False): 2,
        ("薄紅", False): 1,
        ("濃紅", False): 1,
        ("薄空", False): 1,
        ("濃空", False): 1,
        ("薄鼠", False): 3,
        ("白", False): 3,
        ("トイレ", False): 2,
        ("濃鼠", False): 1,
        ("濃鼠", True): 1,
        ("道白", False): 1,
        ("進入制限あり", False): 1,
    }
    assert (report.totals.recolor, report.totals.already_new, report.totals.empty, report.totals.unmapped) == (23, 3, 2, 1)
    assert [(line.value, line.rows) for line in report.unmapped] == [("赤", 1)]
    assert report.skipped == ()
    assert {layer.id: (layer.encoding.codec, layer.encoding.source) for layer in report.layers} == {
        f"{GDB}/{name}": ("utf-8", "gdb") for name in (*EDITED, "DemoSta_3_Space")
    }


@needs_gdal
def test_width_counts_characters_so_a_width_12_field_takes_the_stairs_name(converted: Converted) -> None:
    narrow = next(layer for layer in converted.inspection.theme.layers if layer.id == f"{GDB}/DemoSta_B1_Space")

    assert (narrow.width, narrow.width_unit, narrow.counts.too_wide) == (12, "characters", 0)
    assert _color2(converted.after, "DemoSta_B1_Space") == ["階段・エスカレーター", "在来線改札内", "進入制限エリア"]


@needs_gdal
def test_a_value_wider_than_its_field_is_reported_and_the_row_keeps_its_old_value(converted: Converted) -> None:
    report = converted.inspection.theme
    too_narrow = next(layer for layer in report.layers if layer.id == f"{GDB}/DemoSta_2_Space")

    assert (too_narrow.width, too_narrow.counts.too_wide, too_narrow.counts.recolor) == (8, 1, 1)
    assert next(line.too_wide for line in report.rules if line.old == "白") == 1
    assert _color2(converted.after, "DemoSta_2_Space") == ["白", "在来線改札内"]


@needs_gdal
def test_a_japanese_named_feature_class_converts(converted: Converted) -> None:
    layers = {layer.id: layer for layer in converted.inspection.theme.layers}

    assert f"{GDB}/G空間_0_Space" in layers, converted.inspection.theme.skipped
    assert layers[f"{GDB}/G空間_0_Space"].counts.recolor == 2
    assert _color2(converted.after, "G空間_0_Space") == ["改札外通路", "施設"]


@needs_gdal
def test_converting_moves_no_other_table_field_or_shape(converted: Converted) -> None:
    before, after = converted.before, converted.after
    edited = {before["tables"][name] for name in EDITED}
    old, new = fingerprint(converted.pristine), fingerprint(converted.result)

    assert sorted(old.keys() - new.keys()) == []
    changed = {name for name in new if name not in old or old[name][0] != new[name][0]}
    assert sorted(name for name in changed if name.split(".", 1)[0] not in edited) == []
    system = [name for name in old if name.split(".", 1)[0] in {f"a{n:08x}" for n in range(1, 9)}]
    assert system and all(old[name][0] == new[name][0] for name in system)
    assert before["tables"] == after["tables"]
    for layer, content in before["layers"].items():
        assert after["layers"][layer]["widths"] == content["widths"], layer
        rows_after = after["layers"][layer]["rows"]
        assert [row["fid"] for row in rows_after] == [row["fid"] for row in content["rows"]], layer
        for row, row_after in zip(content["rows"], rows_after):
            kept = {name: value for name, value in row["fields"].items() if name != "color2" and not name.startswith("Shape_")}
            assert {name: row_after["fields"][name] for name in kept} == kept, (layer, row["fid"])
            for measure in ("Shape_Area", "Shape_Length"):
                assert math.isclose(row_after["fields"][measure], row["fields"][measure], rel_tol=1e-6), (layer, measure)
            assert row_after["wkb"] == row["wkb"], (layer, row["fid"])
    assert _color2(after, "DemoSta_3_Space") == _color2(before, "DemoSta_3_Space")


@needs_gdal
def test_every_spatial_and_attribute_index_survives_and_still_finds_the_rewritten_rows(converted: Converted) -> None:
    indexes = {name for name in fingerprint(converted.pristine) if name.endswith((".spx", ".atx"))}
    rows = converted.before["layers"]["DemoSta_1_Space"]["rows"]
    facilities = [row["fid"] for row, written in zip(rows, FLOOR_1_AFTER, strict=True) if written == "施設"]

    assert {name for name in indexes if name.endswith(".atx")}, "the fixture must carry attribute indexes"
    assert indexes <= set(fingerprint(converted.result))
    assert filter_fids(converted.result, "DemoSta_1_Space", "color2 = '施設'", GDAL_PYTHON) == facilities
    assert filter_fids(converted.result, "DemoSta_1_Space", "color2 = '薄空'", GDAL_PYTHON) == []
    assert filter_fids(converted.result, "G空間_0_Space", "color2 = '施設'", GDAL_PYTHON) == [2]


@needs_gdal
def test_reading_a_geodatabase_writes_nothing(converted: Converted, theme: ColorTheme, tmp_path: Path) -> None:
    copy = shutil.copytree(converted.pristine, tmp_path / GDB)
    before = fingerprint(copy)

    read = read_layers(copy, GDB, theme, GDAL_PYTHON)

    assert (len(read.layers), read.tables, read.category_only) == (6, 7, 0)
    assert fingerprint(copy) == before


@needs_gdal
def test_a_second_convert_rewrites_nothing_and_changes_no_file(converted: Converted, theme: ColorTheme) -> None:
    again = [(converted.archive.filename, converted.archive.data)]

    rerun = inspect(theme, again, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).theme
    second = convert(theme, again, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)

    assert rerun.totals.recolor == 0
    assert rerun.totals.already_new == converted.inspection.theme.totals.recolor + converted.inspection.theme.totals.already_new
    assert second.data == converted.archive.data


@needs_gdal
def test_the_download_keeps_upload_order_and_adds_gdal_files_after_the_geodatabase(converted: Converted) -> None:
    uploaded = [name for name in read_zip(converted.upload[0][1]) if not name.endswith(".lock")]
    kept = [name for name in uploaded if name in converted.output]
    names = list(converted.output)

    assert names[: len(kept)] == kept
    added = names[len(kept) :]
    assert added and all(name.startswith(f"{GDB}/") and name not in uploaded for name in added)
    assert converted.inspection.dataset.lock_files_dropped == len(LOCKS)
    assert converted.inspection.dataset.geodatabases == 1
    assert not any(name.endswith(".lock") for name in names)


def _color2_spans(dbf: bytes) -> set[int]:
    table = DbfTable.parse(dbf)
    field = table.field("color2")
    spans: set[int] = set()
    for row in range(table.record_count):
        start = table.header_length + row * table.record_length + field.offset
        spans.update(range(start, start + field.width))
    return spans


@needs_gdal
def test_shapefiles_and_a_geodatabase_in_one_upload_both_convert(converted: Converted, theme: ColorTheme) -> None:
    shapefiles = [(name, data) for name, data in station_members() if data is not None]
    upload = shapefiles + [(f"東京/{name}", data) for name, data in gdb_files(converted.pristine, GDB)]

    report = inspect(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).theme
    output = read_zip(convert(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).data)

    assert report.totals.recolor == 9 + converted.inspection.theme.totals.recolor
    for name, data in shapefiles:
        if name.endswith("/Space.dbf"):
            changed = {index for index, (a, b) in enumerate(zip(data, output[name])) if a != b}
            assert changed and changed <= _color2_spans(data), name
        else:
            assert output[name] == data, name
    gdb_output = {name.removeprefix("東京/"): data for name, data in output.items() if name.startswith(f"東京/{GDB}/")}
    assert gdb_output == {name: data for name, data in converted.output.items() if data is not None and name.startswith(f"{GDB}/")}


def _fake_gdb(prefix: str) -> list[tuple[str, bytes]]:
    return [
        (f"{prefix}/a00000001.gdbtable", b"not really a table"),
        (f"{prefix}/gdb", b"\x05\x00\x00\x00"),
        (f"{prefix}/timestamps", b"\xff" * 8),
    ]


@needs_gdal
def test_a_geodatabase_drawn_by_category_reports_its_tables_instead_of_looking_empty(
    theme: ColorTheme, tmp_path: Path
) -> None:
    units = [
        {"name": name, "dataset": "Station", "fields": [["name", 20], ["category", 20]], "rows": [{"name": "a", "category": "walkway"}]}
        for name in ("DemoSta_1_unit", "DemoSta_B1_unit")
    ]
    opening = {"name": "DemoSta_1_opening", "dataset": "Station", "fields": [["name", 20]], "rows": [{"name": "door"}]}
    upload = gdb_files(build_gdb(tmp_path / GDB, [*units, opening], GDAL_PYTHON), GDB)

    inspection = inspect(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)
    output = read_zip(convert(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).data)

    assert (inspection.theme.layers, inspection.theme.skipped) == ((), ())
    assert (inspection.dataset.geodatabases, inspection.dataset.tables, inspection.dataset.category_only_tables) == (1, 3, 2)
    assert output == dict(upload)


def test_without_a_gdal_python_the_geodatabase_comes_back_as_uploaded_and_shapefiles_still_convert(theme: ColorTheme) -> None:
    shapefiles = [(name, data) for name, data in station_members() if data is not None]
    upload = shapefiles + _fake_gdb(f"東京/{GDB}")

    report = inspect(theme, upload, max_bytes=LIMIT, gdal_python=None).theme
    output = read_zip(convert(theme, upload, max_bytes=LIMIT, gdal_python=None).data)

    assert [(line.id, line.reason) for line in report.skipped] == [(f"東京/{GDB}", "gdb_unavailable")]
    assert report.totals.recolor == 9
    assert list(output) == [name for name, _ in upload]
    assert {name: output[name] for name, _ in _fake_gdb(f"東京/{GDB}")} == dict(_fake_gdb(f"東京/{GDB}"))
    assert output["東京/1/Space.dbf"] != dict(shapefiles)["東京/1/Space.dbf"]


@needs_gdal
def test_a_geodatabase_gdal_cannot_open_is_reported_and_comes_back_as_uploaded(theme: ColorTheme) -> None:
    upload = _fake_gdb(GDB)

    report = inspect(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).theme
    output = read_zip(convert(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON).data)

    assert [(line.id, line.reason) for line in report.skipped] == [(GDB, "unreadable")]
    assert output == dict(upload)


def test_stale_lock_files_inside_a_geodatabase_are_left_out_and_counted(theme: ColorTheme) -> None:
    outside = ("notes/station.lock", b"not ours")
    upload = [("DemoSta.zip", make_zip([*_fake_gdb(GDB), *LOCKS, outside]))]

    inspection = inspect(theme, upload, max_bytes=LIMIT, gdal_python=None)
    output = read_zip(convert(theme, upload, max_bytes=LIMIT, gdal_python=None).data)

    assert inspection.dataset.lock_files_dropped == len(LOCKS)
    assert inspection.dataset.files == len(_fake_gdb(GDB)) + 1
    assert inspection.dataset.geodatabases == 1
    assert list(output) == [name for name, _ in [*_fake_gdb(GDB), outside]]


@needs_gdal
def test_a_zipped_geodatabase_is_checked_and_converted_over_http(converted: Converted, test_client) -> None:
    (name, payload), = converted.upload

    inspected = test_client.post("/api/color-theme/inspect", files=[("files", (name, payload, "application/zip"))])
    downloaded = test_client.post("/api/color-theme/convert", files=[("files", (name, payload, "application/zip"))])

    assert inspected.status_code == 200, inspected.text
    body = inspected.json()
    assert body["dataset"]["geodatabases"] == 1
    assert body["dataset"]["lock_files_dropped"] == len(LOCKS)
    narrow = next(layer for layer in body["theme"]["layers"] if layer["id"] == f"{GDB}/DemoSta_B1_Space")
    assert (narrow["width"], narrow["width_unit"], narrow["encoding"]) == (12, "characters", {"codec": "utf-8", "source": "gdb"})
    assert downloaded.status_code == 200, downloaded.text
    assert read_zip(downloaded.content) == converted.output
