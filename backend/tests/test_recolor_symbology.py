"""Layer files and projects in an upload: only color2 and category renderers change, every other byte and member comes back."""

from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
from typing import Any
import zipfile

import pytest

from backend.src.color_theme import ColorTheme, load_color_theme
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import (
    LAYER_FILE,
    make_project,
    make_zip,
    project_members,
    read_zip,
    station_members,
    unit_project_members,
    zip_members as _members,
)

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 64 * 1024 * 1024
NEW_LABELS = ["改札外通路", "在来線改札内", "新幹線改札内", "施設", "進入制限エリア", "階段・エスカレーター"]


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


def labels(layer: dict[str, Any]) -> list[str]:
    return [cls["label"] for group in layer["renderer"]["groups"] for cls in group["classes"]]


def _without_groups(layer: dict[str, Any]) -> dict[str, Any]:
    return {**layer, "renderer": {key: value for key, value in layer["renderer"].items() if key != "groups"}}


def test_a_lone_layer_file_comes_back_rethemed_with_everything_else_equal(theme: ColorTheme) -> None:
    source = LAYER_FILE.read_bytes()
    upload = [("DemoSta_0_Space.lyrx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    archive = convert(theme, upload, max_bytes=LIMIT)

    assert archive.filename == "DemoSta_0_Space_new-colors.zip"
    output = read_zip(archive.data)
    assert list(output) == ["DemoSta_0_Space.lyrx"]
    before, after = json.loads(source.decode("utf-8-sig")), json.loads(output["DemoSta_0_Space.lyrx"].decode("utf-8-sig"))
    assert labels(after["layerDefinitions"][0]) == NEW_LABELS
    assert {**after, "layerDefinitions": [_without_groups(after["layerDefinitions"][0])]} == {
        **before,
        "layerDefinitions": [_without_groups(before["layerDefinitions"][0])],
    }
    assert after["layerDefinitions"][0]["renderer"]["groups"][0]["heading"] == "color2"
    ((line),) = report.symbology
    assert (line.path, line.kind, line.unreadable) == ("DemoSta_0_Space.lyrx", "lyrx", False)
    assert [(r.layer, r.outcome, r.classes_before, r.classes_after) for r in line.renderers] == [
        ("DemoSta_0_Space", "rewritten", 14, 6)
    ]
    assert report.totals.rows == 0 and report.layers == ()


def test_a_leading_bom_is_kept(theme: ColorTheme) -> None:
    source = b"\xef\xbb\xbf" + LAYER_FILE.read_bytes().removeprefix(b"\xef\xbb\xbf")

    output = read_zip(convert(theme, [("a.lyrx", source)], max_bytes=LIMIT).data)["a.lyrx"]

    assert output.startswith(b"\xef\xbb\xbf{")
    assert labels(json.loads(output.decode("utf-8-sig"))["layerDefinitions"][0]) == NEW_LABELS


@pytest.mark.parametrize(
    "source",
    [b'{"type" : "CIMLayerDocument", "layerDefinitions" : [', b"\xff\xfe not utf-8", b"PK\x03\x04 not a zip"],
    ids=["truncated", "not utf-8", "zip header"],
)
def test_a_layer_file_that_does_not_parse_is_reported_and_comes_back_untouched(theme: ColorTheme, source: bytes) -> None:
    upload = [("st/a.lyrx", source), ("st/b.aprx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    output = read_zip(convert(theme, upload, max_bytes=LIMIT).data)

    assert [(line.path, line.unreadable, line.renderers) for line in report.symbology] == [
        ("st/a.lyrx", True, ()),
        ("st/b.aprx", True, ()),
    ]
    assert output == {"st/a.lyrx": source, "st/b.aprx": source}


def test_a_layer_file_without_a_color2_renderer_comes_back_byte_for_byte(theme: ColorTheme) -> None:
    doc = json.loads(LAYER_FILE.read_text(encoding="utf-8-sig"))
    doc["layerDefinitions"][0]["renderer"]["fields"] = ["category"]
    source = json.dumps(doc, ensure_ascii=False, indent=4).encode("utf-8")

    report = inspect(theme, [("a.lyrx", source)], max_bytes=LIMIT).theme
    output = read_zip(convert(theme, [("a.lyrx", source)], max_bytes=LIMIT).data)

    assert [(line.path, line.renderers) for line in report.symbology] == [("a.lyrx", ())]
    assert output["a.lyrx"] == source


def test_a_project_changes_only_the_members_with_a_color2_renderer(theme: ColorTheme) -> None:
    source = make_project(project_members())
    upload = [("DemoSta.aprx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    output = read_zip(convert(theme, upload, max_bytes=LIMIT).data)["DemoSta.aprx"]

    before, after = _members(source), _members(output)
    assert [member[0] for member in after] == [member[0] for member in before]
    changed = [new[0] for old, new in zip(before, after) if old != new]
    assert changed == ["map/demosta_0_space.json", "map/demosta_1_space.json"]
    for old, new in zip(before, after):
        assert (new[0], new[1], new[2]) == (old[0], old[1], old[2])
        if new[0] in changed:
            old_layer, new_layer = json.loads(old[4]), json.loads(new[4])
            assert _without_groups(new_layer) == _without_groups(old_layer)
            assert labels(new_layer)[:6] == NEW_LABELS
    assert labels(json.loads(after[4][4])) == [*NEW_LABELS, "赤"]
    ((line),) = report.symbology
    assert [(r.layer, r.field, r.outcome, r.reason, r.kept) for r in line.renderers] == [
        ("DemoSta_0_Space", "color2", "rewritten", None, ()),
        ("DemoSta_1_Space", "color2", "rewritten", None, ("赤",)),
        ("DemoSta_B1_Space", "color2", "left_alone", "expression", ()),
    ]


def test_a_project_drawn_by_category_changes_only_its_unit_layers_and_a_second_run_changes_nothing(theme: ColorTheme) -> None:
    source = make_project(unit_project_members())
    upload = [("DemoSta_units.aprx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    archive = convert(theme, upload, max_bytes=LIMIT)

    output = read_zip(archive.data)["DemoSta_units.aprx"]
    before, after = _members(source), _members(output)
    assert [member[:3] for member in after] == [member[:3] for member in before]
    changed = [new[0] for old, new in zip(before, after) if old != new]
    assert changed == ["map/demosta_1_unit.json", "map/demosta_b1_unit.json"]
    for old, new in zip(before, after):
        if new[0] in changed:
            old_layer, new_layer = json.loads(old[4]), json.loads(new[4])
            assert _without_groups(new_layer) == _without_groups(old_layer)
            assert new_layer["renderer"]["fields"] == ["category"]
            assert labels(new_layer) == ["改札外通路", "在来線改札内", "施設", "進入制限エリア", "階段・エスカレーター", "vegetation"]
    ((line),) = report.symbology
    assert [(r.layer, r.field, r.outcome, r.classes_before, r.classes_after, r.kept) for r in line.renderers] == [
        ("DemoSta_1_unit", "category", "rewritten", 30, 6, ("vegetation",)),
        ("DemoSta_B1_unit", "category", "rewritten", 30, 6, ("vegetation",)),
    ]

    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT).theme
    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT)
    assert [(r.field, r.outcome, r.classes_after) for r in rerun.symbology[0].renderers] == [("category", "already_new", 6)] * 2
    assert second.data == archive.data


def test_a_project_member_that_does_not_parse_is_reported_and_kept(theme: ColorTheme) -> None:
    members = project_members()
    broken = b'{"type":"CIMFeatureLayer","renderer":{"type":"CIMUniqueValueRenderer","fields":["color2"]'
    members.insert(3, ("map/broken.json", broken, zipfile.ZIP_DEFLATED))

    report = inspect(theme, [("p.aprx", make_project(members))], max_bytes=LIMIT).theme
    output = read_zip(convert(theme, [("p.aprx", make_project(members))], max_bytes=LIMIT).data)["p.aprx"]

    assert [(r.layer, r.field, r.outcome, r.reason) for r in report.symbology[0].renderers][0] == (
        "map/broken.json",
        None,
        "left_alone",
        "unreadable",
    )
    assert dict((name, data) for name, *_, data in _members(output))["map/broken.json"] == broken


def test_a_project_larger_than_the_limit_once_expanded_is_not_read(theme: ColorTheme) -> None:
    source = make_project(project_members())

    report = inspect(theme, [("p.aprx", source)], max_bytes=len(source) + 10).theme

    assert report.symbology[0].unreadable


def test_projects_in_one_upload_share_the_expansion_limit(theme: ColorTheme) -> None:
    source = make_project(project_members())
    with zipfile.ZipFile(BytesIO(source)) as archive:
        expanded = sum(info.file_size for info in archive.infolist())
    assert 2 * len(source) <= expanded + expanded // 2 < 2 * expanded

    report = inspect(theme, [("st/a.aprx", source), ("st/b.aprx", source)], max_bytes=expanded + expanded // 2).theme

    assert [line.unreadable for line in report.symbology] == [False, True]


def test_a_project_that_fails_while_being_read_still_uses_up_the_expansion_limit(theme: ColorTheme) -> None:
    source = make_project(project_members())
    with zipfile.ZipFile(BytesIO(source)) as archive:
        first = archive.infolist()[0]
        expanded = sum(info.file_size for info in archive.infolist())
    corrupt = bytearray(source)
    middle = first.header_offset + 30 + len(first.filename.encode()) + first.compress_size // 2
    corrupt[middle] ^= 0xFF

    report = inspect(theme, [("st/a.aprx", bytes(corrupt)), ("st/b.aprx", source)], max_bytes=expanded + expanded // 2).theme

    assert [line.unreadable for line in report.symbology] == [True, True]


def test_other_files_in_the_upload_count_against_a_projects_expansion_limit(theme: ColorTheme) -> None:
    source = make_project(project_members())
    with zipfile.ZipFile(BytesIO(source)) as archive:
        expanded = sum(info.file_size for info in archive.infolist())
    filler = b"x" * expanded
    limit = len(filler) + len(source) + expanded // 2

    report = inspect(theme, [("st/notes.txt", filler), ("st/a.aprx", source)], max_bytes=limit).theme

    assert report.symbology[0].unreadable


def test_a_layer_file_nested_too_deep_to_walk_is_reported_and_comes_back_untouched(theme: ColorTheme) -> None:
    source = (b"[" * 5000) + (b"]" * 5000)

    report = inspect(theme, [("deep.lyrx", source)], max_bytes=LIMIT).theme
    output = convert(theme, [("deep.lyrx", source)], max_bytes=LIMIT)

    assert report.symbology[0].unreadable
    with zipfile.ZipFile(BytesIO(output.data)) as archive:
        assert archive.read("deep.lyrx") == source


def test_a_station_zip_with_layer_files_rewrites_rows_and_renderers_in_one_pass(theme: ColorTheme) -> None:
    project = make_project(project_members())
    upload = [
        (
            "JRTokyoSta_6677.zip",
            make_zip([*station_members(), ("JRTokyoSta_6677.shp/style/space.lyrx", LAYER_FILE.read_bytes()), ("JRTokyoSta_6677.shp/st.aprx", project)]),
        )
    ]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    archive = convert(theme, upload, max_bytes=LIMIT)

    assert report.totals.recolor > 0
    assert [line.path for line in report.symbology] == ["JRTokyoSta_6677.shp/style/space.lyrx", "JRTokyoSta_6677.shp/st.aprx"]
    output = read_zip(archive.data)
    assert labels(json.loads(output["JRTokyoSta_6677.shp/style/space.lyrx"].decode("utf-8-sig"))["layerDefinitions"][0]) == NEW_LABELS
    assert output["JRTokyoSta_6677.shp/st.aprx"] != project

    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT).theme
    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT)
    assert rerun.totals.recolor == 0
    assert {r.outcome for line in rerun.symbology for r in line.renderers} == {"already_new", "left_alone"}
    assert second.data == archive.data
