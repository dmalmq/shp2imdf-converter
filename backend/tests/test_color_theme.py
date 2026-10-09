"""The colour theme table and the plan it makes: wrong mappings, broken tables, and second runs."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from backend.src.color_theme import (
    ColorTheme,
    Encoding,
    LayerInput,
    Row,
    Rule,
    SkippedLayer,
    WidthUnit,
    load_color_theme,
    plan,
)

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"

# The Figma Old -> New エリアカラー table, typed out independently of the config so a typo there fails here.
# old value -> (written area name, spec, hex)
FIGMA = {
    "黄": ("在来線改札内", "PaleBlue 050", "#F2F7FB"),
    "橙": ("新幹線改札内", "PaleBlue 100", "#E5EFF7"),
    "緑": ("新幹線改札内", "PaleBlue 100", "#E5EFF7"),
    "ラチ外白": ("改札外通路", "Mono 000", "#FFFFFF"),
    "薄紅": ("在来線改札内", "PaleBlue 050", "#F2F7FB"),
    "濃紅": ("新幹線改札内", "PaleBlue 100", "#E5EFF7"),
    "薄空": ("施設", "Turquoise 150", "#DDEBEC"),
    "濃空": ("施設", "Turquoise 150", "#DDEBEC"),
    "薄鼠": ("進入制限エリア", "Mono 050", "#F2F2F2"),
    "白": ("階段・エスカレーター", "Mono 000", "#FFFFFF"),
    "トイレ": ("施設", "Turquoise 150", "#DDEBEC"),
    "濃鼠": ("改札外通路", "Mono 000", "#FFFFFF"),
    "道白": ("改札外通路", "Mono 000", "#FFFFFF"),
    "進入制限あり": ("進入制限エリア", "Mono 050", "#F2F2F2"),
}
NEW_VALUES = {"改札外通路", "在来線改札内", "新幹線改札内", "施設", "進入制限エリア", "階段・エスカレーター"}
RESTROOMS = [f"B{n:03d}" for n in range(7, 15)]

# The operator-approved category -> area table for stations drawn by category, typed out independently of the config.
# written area name and fill -> the categories drawn as it
CATEGORY_TABLE = {
    ("改札外通路", "#FFFFFF"): ["walkway", "ramp", "road"],
    ("在来線改札内", "#F2F7FB"): ["walkway_sta", "ramp_sta", "platform"],
    ("施設", "#DDEBEC"): [
        "store",
        "store_sta",
        "ATM",
        "clinic",
        "pharmacy",
        "theater",
        "ticket office",
        "restroom.female",
        "restroom.male",
        "restroom.wheelchair",
        "accessible restroom",
    ],
    ("進入制限エリア", "#F2F2F2"): [
        "elevator",
        "auditorium",
        "information desk",
        "mothersroom",
        "nonpublic",
        "smokingarea",
        "unenclosedarea",
        "unspecified",
        "waitingroom",
    ],
    ("階段・エスカレーター", "#FFFFFF"): ["stairs", "escalator", "opentobelow"],
}
UTF8 = Encoding("utf-8", "cpg")


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


def _written(theme: ColorTheme, value: str, category: str | None) -> tuple[str, str, str]:
    outcome = theme.classify(value, category)
    assert isinstance(outcome, Rule), f"{value} on {category} was kept as {outcome}"
    return outcome.area.value, outcome.area.spec, outcome.area.hex


def test_every_old_value_maps_as_the_figma_table_says(theme: ColorTheme) -> None:
    assert {rule.old for rule in theme.rules} == set(FIGMA)
    for old, expected in FIGMA.items():
        assert _written(theme, old, None) == expected, old
        assert _written(theme, old, "B999") == expected, old


def test_every_category_is_drawn_as_the_area_the_operator_approved(theme: ColorTheme) -> None:
    expected = {category: area for area, categories in CATEGORY_TABLE.items() for category in categories}
    assert len(expected) == 29

    assert {category: (area.value, area.hex) for category, area in theme.category_areas.items()} == expected


@pytest.mark.parametrize("category", ["vegetation", "checkin.kiosk", "equipment", "Walkway", "atm", "B021", ""])
def test_a_category_outside_the_table_has_no_area(theme: ColorTheme, category: str) -> None:
    assert category not in theme.category_areas


def test_dark_grey_on_a_restroom_becomes_facilities(theme: ColorTheme) -> None:
    for code in RESTROOMS:
        assert _written(theme, "濃鼠", code) == ("施設", "Turquoise 150", "#DDEBEC"), code
    assert _written(theme, "濃鼠", "B015") == ("改札外通路", "Mono 000", "#FFFFFF")
    assert _written(theme, "薄鼠", "B014") == ("進入制限エリア", "Mono 050", "#F2F2F2")


def test_restroom_override_claims_exactly_the_restroom_codes() -> None:
    mappings = json.loads((CONFIG.parent / "b-codes.json").read_text(encoding="utf-8"))["mappings"]
    restrooms = {code for code, category in mappings.items() if category.startswith("restroom")}
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    overrides = [rule for rule in config["rules"] if "categories" in rule]
    assert [(rule["old"], set(rule["categories"])) for rule in overrides] == [("濃鼠", restrooms)]


def test_the_written_vocabulary_is_the_six_area_names(theme: ColorTheme) -> None:
    assert theme.new_values == NEW_VALUES
    assert theme.field == "color2"
    assert theme.category_field == "category"


def test_layer_files_are_outlined_in_the_figma_border_colour(theme: ColorTheme) -> None:
    assert (theme.outline.spec, theme.outline.hex, theme.outline.width_pt) == ("TurquoiseGray 1000", "#657678", 0.3)


def test_an_unknown_value_is_drawn_in_a_grey_that_is_no_areas_fill(theme: ColorTheme) -> None:
    assert (theme.other.label, theme.other.hex) == ("その他 (Other)", "#D9D9D9")
    assert theme.other.hex not in {area.hex for area in theme.areas}


@pytest.mark.parametrize(
    ("value", "category", "expected"),
    [
        ("", "B001", "empty"),
        ("施設", "B007", "already_new"),
        ("階段・エスカレーター", None, "already_new"),
        ("赤", "B001", "unmapped"),
        (" 白", "B021", "unmapped"),
        ("白 ", "B021", "unmapped"),
        ("Mono 000", None, "unmapped"),
    ],
)
def test_values_outside_the_old_table_are_kept(theme: ColorTheme, value: str, category: str | None, expected: str) -> None:
    assert theme.classify(value, category) == expected


def _broken(tmp_path: Path, edit) -> Path:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    edit(config)
    path = tmp_path / "theme.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return path


def _rule(config: dict, old: str, *, override: bool = False) -> dict:
    return next(rule for rule in config["rules"] if rule["old"] == old and ("categories" in rule) == override)


BROKEN = {
    "unknown area": lambda c: _rule(c, "黄").update(area="paid"),
    "two default rules": lambda c: c["rules"].append(copy.deepcopy(_rule(c, "黄"))),
    "only an override": lambda c: c["rules"].remove(_rule(c, "濃鼠")),
    "overlapping overrides": lambda c: c["rules"].append(
        {**copy.deepcopy(_rule(c, "濃鼠", override=True)), "categories": ["B014", "B015"]}
    ),
    "written value is an old value": lambda c: c["areas"][0].update(value="白"),
    "two areas write one value": lambda c: c["areas"][1].update(value=c["areas"][0]["value"]),
    "unknown key": lambda c: _rule(c, "濃鼠", override=True).update(catagories=["B001"]),
    "missing key": lambda c: _rule(c, "黄").pop("scope"),
    "padded old value": lambda c: _rule(c, "黄").update(old="黄 "),
    "bad colour": lambda c: c["areas"][0].update(hex="white"),
    "empty override": lambda c: _rule(c, "濃鼠", override=True).update(categories=[]),
    "no outline": lambda c: c.pop("outline"),
    "bad outline colour": lambda c: c["outline"].update(hex="#65767"),
    "no outline width": lambda c: c["outline"].pop("width_pt"),
    "outline width of zero": lambda c: c["outline"].update(width_pt=0),
    "outline width that is not a number": lambda c: c["outline"].update(width_pt="0.3"),
    "no symbol for unknown values": lambda c: c.pop("other"),
    "unknown values without a Japanese name": lambda c: c["other"]["name"].pop("ja"),
    "no category table": lambda c: c.pop("category_areas"),
    "category in an unknown area": lambda c: c["category_areas"][0].update(area="outside"),
    "category in two areas": lambda c: c["category_areas"][1]["categories"].append("walkway"),
    "category twice in one area": lambda c: c["category_areas"][0]["categories"].append("walkway"),
    "area listed twice": lambda c: c["category_areas"].append({"area": "free_area", "categories": ["plaza"]}),
    "unknown key in the category table": lambda c: c["category_areas"][0].update(catagories=["plaza"]),
    "area without categories": lambda c: c["category_areas"][0].update(categories=[]),
    "padded category": lambda c: c["category_areas"][0]["categories"].append("plaza "),
    "category that is not text": lambda c: c["category_areas"][0]["categories"].append(7),
    "one field for both tables": lambda c: c.update(category_field="COLOR2"),
}


@pytest.mark.parametrize("broken", sorted(BROKEN))
def test_a_broken_table_stops_the_load(tmp_path: Path, broken: str) -> None:
    with pytest.raises(ValueError):
        load_color_theme(_broken(tmp_path, BROKEN[broken]))


def _layer(
    layer_id: str,
    values: list[tuple[str | None, str | None]],
    *,
    width: int = 254,
    width_unit: WidthUnit = "bytes",
    encoding: Encoding = UTF8,
) -> LayerInput:
    rows = [Row(index=index, value=value, category=category) for index, (value, category) in enumerate(values)]
    return LayerInput(id=layer_id, rows=rows, width=width, width_unit=width_unit, encoding=encoding)


def test_plan_counts_each_fate_and_edits_only_rewritten_rows(theme: ColorTheme) -> None:
    space = _layer(
        "st/1_Space.dbf",
        [("白", "B021"), ("濃鼠", "B008"), ("濃鼠", "B999"), ("施設", "B001"), ("", None), ("赤", "B001"), (None, "B001")],
    )
    other = _layer("st/2_Space.dbf", [("赤", "B019"), ("赤", "B019"), ("緑", None)])

    result = plan(theme, [space, SkippedLayer("st/bad.dbf", "unreadable"), other])

    assert dict(result.edits) == {
        "st/1_Space.dbf": {0: "階段・エスカレーター", 1: "施設", 2: "改札外通路"},
        "st/2_Space.dbf": {2: "新幹線改札内"},
    }
    report = result.report
    first = report.layers[0].counts
    assert (first.rows, first.recolor, first.already_new, first.empty, first.unmapped, first.undecodable) == (7, 3, 1, 1, 1, 1)
    assert report.totals.recolor == 4
    assert report.totals.rows == 10
    assert [(line.value, line.rows, line.layers) for line in report.unmapped] == [
        ("赤", 3, ("st/1_Space.dbf", "st/2_Space.dbf"))
    ]
    assert [(line.id, line.reason) for line in report.skipped] == [("st/bad.dbf", "unreadable")]
    by_rule = {(line.old, line.categories): line.rows for line in report.rules}
    assert by_rule[("濃鼠", tuple(RESTROOMS))] == 1
    assert by_rule[("濃鼠", None)] == 1
    assert by_rule[("緑", None)] == 1
    assert by_rule[("黄", None)] == 0


def test_every_rule_is_reported_in_table_order_before_any_upload(theme: ColorTheme) -> None:
    report = plan(theme, []).report

    assert [line.old for line in report.rules] == [rule.old for rule in theme.rules]
    assert all(line.rows == 0 and line.too_wide == 0 for line in report.rules)
    stairs = next(line for line in report.rules if line.old == "白")
    assert (stairs.value, stairs.spec, stairs.hex, stairs.area_name.ja) == (
        "階段・エスカレーター",
        "Mono 000",
        "#FFFFFF",
        "階段・エスカレーター",
    )
    assert stairs.scope.ja == "階段、エスカレーター、動く歩道、吹抜"


def test_a_value_wider_than_the_field_in_its_own_codec_is_reported_not_written(theme: ColorTheme) -> None:
    rows = [("白", "B021"), ("黄", None)]
    # 階段・エスカレーター is 30 bytes in UTF-8 and 20 in cp932; 在来線改札内 is 18 and 12.
    utf8 = plan(theme, [_layer("u.dbf", rows, width=24)])
    cp932 = plan(theme, [_layer("c.dbf", rows, width=24, encoding=Encoding("cp932", "cpg"))])

    assert dict(utf8.edits) == {"u.dbf": {1: "在来線改札内"}}
    stairs = next(line for line in utf8.report.rules if line.old == "白")
    assert (stairs.rows, stairs.too_wide) == (0, 1)
    assert utf8.report.totals.too_wide == 1
    assert dict(cp932.edits) == {"c.dbf": {0: "階段・エスカレーター", 1: "在来線改札内"}}


@pytest.mark.parametrize(
    ("width", "unit", "written"),
    [
        (12, "characters", True),
        (10, "characters", True),
        (9, "characters", False),
        (0, "characters", True),
        (30, "bytes", True),
        (29, "bytes", False),
        (0, "bytes", False),
    ],
)
def test_a_geodatabase_width_counts_characters_and_zero_is_no_limit(
    theme: ColorTheme, width: int, unit: WidthUnit, written: bool
) -> None:
    # 階段・エスカレーター is 10 characters and 30 UTF-8 bytes.
    result = plan(theme, [_layer("g", [("白", "B021")], width=width, width_unit=unit, encoding=Encoding("utf-8", "gdb"))])

    assert dict(result.edits) == ({"g": {0: "階段・エスカレーター"}} if written else {})
    assert result.report.totals.too_wide == (0 if written else 1)
    assert (result.report.layers[0].width, result.report.layers[0].width_unit) == (width, unit)


def test_planning_the_written_rows_again_changes_nothing(theme: ColorTheme) -> None:
    values = [(old, category) for old in FIGMA for category in (None, "B008", "B999")]
    first = plan(theme, [_layer("a.dbf", values)])
    rewritten = [
        (first.edits["a.dbf"].get(index, value), category) for index, (value, category) in enumerate(values)
    ]

    second = plan(theme, [_layer("a.dbf", rewritten)])

    assert first.report.totals.recolor == len(values)
    assert dict(second.edits) == {}
    assert second.report.totals.recolor == 0
    assert second.report.totals.already_new == len(values)
