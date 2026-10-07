"""Retheming color2 unique-value renderers in CIM JSON: colours, classes, collateral damage and second runs."""

from __future__ import annotations

from collections import Counter
import copy
import json
from pathlib import Path
from typing import Any

import pytest

from backend.src.cim_symbology import retheme_document
from backend.src.color_theme import ColorTheme, load_color_theme

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
TOKYO_LAYER = Path(__file__).resolve().parent / "fixtures" / "color_theme" / "DemoSta_0_Space.lyrx"
OUTLINE = "#657678"

# The Figma New table, typed out independently of the config: label, values in order, fill.
NEW_CLASSES = [
    ("改札外通路", ["改札外通路", "ラチ外白", "濃鼠", "道白"], "#FFFFFF"),
    ("在来線改札内", ["在来線改札内", "黄", "薄紅"], "#F2F7FB"),
    ("新幹線改札内", ["新幹線改札内", "橙", "緑", "濃紅"], "#E5EFF7"),
    ("施設", ["施設", "薄空", "濃空", "トイレ"], "#DDEBEC"),
    ("進入制限エリア", ["進入制限エリア", "薄鼠", "進入制限あり"], "#F2F2F2"),
    ("階段・エスカレーター", ["階段・エスカレーター", "白"], "#FFFFFF"),
]


@pytest.fixture(scope="module")
def theme() -> ColorTheme:
    return load_color_theme(CONFIG)


def tokyo_document() -> dict[str, Any]:
    return json.loads(TOKYO_LAYER.read_text(encoding="utf-8-sig"))


def _rgb(hex_colour: str) -> dict[str, Any]:
    return {"type": "CIMRGBColor", "values": [int(hex_colour[i : i + 2], 16) for i in (1, 3, 5)] + [100]}


def _hex(colour: dict[str, Any]) -> str:
    return "#" + "".join(f"{int(channel):02X}" for channel in colour["values"][:3])


def stroke(hex_colour: str = "#828282", width: float = 0.3) -> dict[str, Any]:
    return {"type": "CIMSolidStroke", "enable": True, "width": width, "color": _rgb(hex_colour)}


def uv_class(values: list[str], fill: str, *, strokes: list[dict[str, Any]] | None = None, label: str | None = None) -> dict[str, Any]:
    layers = [stroke()] if strokes is None else strokes
    return {
        "type": "CIMUniqueValueClass",
        "label": label or values[0],
        "patch": "Default",
        "symbol": {
            "type": "CIMSymbolReference",
            "symbol": {
                "type": "CIMPolygonSymbol",
                "symbolLayers": [*layers, {"type": "CIMSolidFill", "enable": True, "color": _rgb(fill)}],
                "angleAlignment": "Map",
            },
        },
        "values": [{"type": "CIMUniqueValue", "fieldValues": [value]} for value in values],
        "visible": True,
    }


def renderer(classes: list[dict[str, Any]], fields: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "type": "CIMUniqueValueRenderer",
        "defaultLabel": "<all other values>",
        "defaultSymbol": uv_class(["x"], "#00E6A9")["symbol"],
        "fields": ["color2"] if fields is None else fields,
        "groups": [{"type": "CIMUniqueValueGroup", "heading": "color2", "classes": classes}],
        "useDefaultSymbol": True,
        **extra,
    }


def layer_doc(*renderers: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "CIMLayerDocument",
        "version": "3.6.0",
        "layerDefinitions": [
            {"type": "CIMFeatureLayer", "name": f"Layer{index}", "renderer": item} for index, item in enumerate(renderers)
        ],
    }


def classes_of(doc: dict[str, Any], index: int = 0) -> list[dict[str, Any]]:
    return [cls for group in doc["layerDefinitions"][index]["renderer"]["groups"] for cls in group["classes"]]


def values_of(cls: dict[str, Any]) -> list[str]:
    return [value["fieldValues"][0] for value in cls["values"]]


def symbol_layers(cls: dict[str, Any]) -> list[dict[str, Any]]:
    return cls["symbol"]["symbol"]["symbolLayers"]


def fills(cls: dict[str, Any]) -> list[str]:
    return [_hex(layer["color"]) for layer in symbol_layers(cls) if layer["type"] == "CIMSolidFill"]


def test_tokyo_layer_becomes_six_classes_in_the_new_fills_outlined_in_the_border_colour(theme: ColorTheme) -> None:
    doc = tokyo_document()
    assert len(classes_of(doc)) == 14

    changes = retheme_document(doc, theme)

    classes = classes_of(doc)
    assert [(cls["label"], values_of(cls), fills(cls)) for cls in classes] == [
        (label, values, [fill]) for label, values, fill in NEW_CLASSES
    ]
    outlines = []
    for cls in classes:
        strokes = [layer for layer in symbol_layers(cls) if layer["type"] == "CIMSolidStroke"]
        assert len(strokes) == 1 and symbol_layers(cls)[0] is strokes[0], cls["label"]
        outlines.append((_hex(strokes[0]["color"]), strokes[0]["width"]))
    # Widths are kept: 66 of Tokyo's 127 layers, this one among them, draw 白 at 0.7 pt.
    assert outlines == [(OUTLINE, 0.3)] * 5 + [(OUTLINE, 0.7)]
    assert [(c.layer, c.outcome, c.classes_before, c.classes_after, c.kept) for c in changes] == [
        ("DemoSta_0_Space", "rewritten", 14, 6, ())
    ]
    assert changes[0].areas == (
        "free_area",
        "paid_area",
        "paid_area_shinkansen",
        "facilities",
        "restricted",
        "stairs_escalators",
    )


def test_unconverted_data_still_draws_because_each_class_lists_its_old_values(theme: ColorTheme) -> None:
    doc = layer_doc(renderer([uv_class(["黄"], "#FCFCE3")]))

    retheme_document(doc, theme)

    assert [(cls["label"], values_of(cls), fills(cls)) for cls in classes_of(doc)] == [
        ("在来線改札内", ["在来線改札内", "黄", "薄紅"], ["#F2F7FB"])
    ]


def _mixed() -> dict[str, Any]:
    return layer_doc(
        renderer(
            [
                uv_class(["黄", "赤"], "#FCFCE3"),
                uv_class(["青"], "#0000FF", label="Blue"),
                uv_class(["白"], "#FFFFFF", strokes=[]),
                uv_class(["薄紅", "赤"], "#FFECE6"),
                uv_class(["施設"], "#DDEBEC"),
            ]
        )
    )


def test_each_value_is_matched_by_exactly_one_class(theme: ColorTheme) -> None:
    for doc in (tokyo_document(), _mixed()):
        retheme_document(doc, theme)

        counts = Counter(value for cls in classes_of(doc) for value in values_of(cls))
        assert {value: n for value, n in counts.items() if n > 1} == {}


def test_values_the_theme_does_not_know_keep_their_old_class_after_the_new_ones(theme: ColorTheme) -> None:
    doc = _mixed()
    blue = copy.deepcopy(classes_of(doc)[1])

    (change,) = retheme_document(doc, theme)

    classes = classes_of(doc)
    assert [(cls["label"], values_of(cls), fills(cls)) for cls in classes] == [
        ("在来線改札内", ["在来線改札内", "黄", "薄紅"], ["#F2F7FB"]),
        ("施設", ["施設", "薄空", "濃空", "トイレ"], ["#DDEBEC"]),
        ("階段・エスカレーター", ["階段・エスカレーター", "白"], ["#FFFFFF"]),
        ("赤", ["赤"], ["#FCFCE3"]),
        ("Blue", ["青"], ["#0000FF"]),
    ]
    assert classes[4] == blue
    assert change.kept == ("赤", "青")
    assert (change.classes_before, change.classes_after) == (5, 5)


def test_an_added_outline_is_drawn_on_top_at_the_renderers_common_width(theme: ColorTheme) -> None:
    doc = layer_doc(
        renderer(
            [
                uv_class(["白"], "#FFFFFF", strokes=[]),
                uv_class(["黄"], "#FCFCE3", strokes=[stroke(width=0.5)]),
                uv_class(["薄空"], "#E5F8FF", strokes=[stroke(width=0.5)]),
                uv_class(["薄鼠"], "#E5E6E6", strokes=[stroke(width=0.3)]),
            ]
        ),
        renderer([uv_class(["白"], "#FFFFFF", strokes=[])]),
    )

    retheme_document(doc, theme)

    stairs = next(cls for cls in classes_of(doc, 0) if cls["label"] == "階段・エスカレーター")
    first = symbol_layers(stairs)[0]
    assert (first["type"], first["width"], _hex(first["color"])) == ("CIMSolidStroke", 0.5, OUTLINE)
    assert [layer["type"] for layer in symbol_layers(stairs)] == ["CIMSolidStroke", "CIMSolidFill"]
    restricted = next(cls for cls in classes_of(doc, 0) if cls["label"] == "進入制限エリア")
    assert symbol_layers(restricted)[0]["width"] == 0.3
    (lone,) = classes_of(doc, 1)
    assert [(layer["type"], layer.get("width")) for layer in symbol_layers(lone)] == [
        ("CIMSolidStroke", 0.3),
        ("CIMSolidFill", None),
    ]


def test_a_class_drawn_without_a_solid_fill_gains_the_area_fill_under_its_own_layers(theme: ColorTheme) -> None:
    hatched = uv_class(["薄空"], "#E5F8FF")
    hatched["symbol"]["symbol"]["symbolLayers"][-1] = {"type": "CIMHatchFill", "enable": True, "separation": 5}
    doc = layer_doc(renderer([hatched]))

    retheme_document(doc, theme)

    (facilities,) = classes_of(doc)
    assert [layer["type"] for layer in symbol_layers(facilities)] == ["CIMSolidStroke", "CIMHatchFill", "CIMSolidFill"]
    assert fills(facilities) == ["#DDEBEC"]
    assert symbol_layers(facilities)[-1]["enable"] is True


def test_switched_off_fill_and_outline_do_not_count_as_drawn(theme: ColorTheme) -> None:
    hidden = uv_class(["薄空"], "#E5F8FF", strokes=[{**stroke(), "enable": False}])
    hidden["symbol"]["symbol"]["symbolLayers"][-1]["enable"] = False
    doc = layer_doc(renderer([hidden]))

    retheme_document(doc, theme)

    (facilities,) = classes_of(doc)
    drawn = [layer for layer in symbol_layers(facilities) if layer.get("enable") is not False]
    assert [(layer["type"], _hex(layer["color"])) for layer in drawn] == [
        ("CIMSolidStroke", OUTLINE),
        ("CIMSolidFill", "#DDEBEC"),
    ]
    assert drawn[0] is symbol_layers(facilities)[0]
    assert drawn[1] is symbol_layers(facilities)[-1]


def test_a_fully_transparent_fill_or_outline_comes_back_opaque_and_a_tinted_one_keeps_its_alpha(theme: ColorTheme) -> None:
    clear = uv_class(["薄空"], "#E5F8FF")
    for layer in symbol_layers(clear):
        layer["color"]["values"][3] = 0
    tinted = uv_class(["黄"], "#FCFCE3")
    symbol_layers(tinted)[-1]["color"]["values"][3] = 40
    doc = layer_doc(renderer([clear, tinted]))

    retheme_document(doc, theme)

    by_label = {cls["label"]: cls for cls in classes_of(doc)}
    assert [layer["color"]["values"][3] for layer in symbol_layers(by_label["施設"])] == [100, 100]
    assert symbol_layers(by_label["在来線改札内"])[-1]["color"]["values"][3] == 40


def test_a_switched_off_stroke_does_not_set_the_width_of_an_added_outline(theme: ColorTheme) -> None:
    doc = layer_doc(renderer([uv_class(["白"], "#FFFFFF", strokes=[{**stroke(width=10), "enable": False}])]))

    retheme_document(doc, theme)

    (stairs,) = classes_of(doc)
    assert (symbol_layers(stairs)[0]["enable"], symbol_layers(stairs)[0]["width"]) == (True, 0.3)


def test_a_merged_class_is_shown_when_any_class_it_replaces_was_shown(theme: ColorTheme) -> None:
    hidden_yellow = {**uv_class(["黄"], "#FCFCE3"), "visible": False}
    hidden_sky = {**uv_class(["薄空"], "#E5F8FF"), "visible": False}
    doc = layer_doc(renderer([hidden_yellow, uv_class(["薄紅"], "#FFECE6"), hidden_sky]))

    retheme_document(doc, theme)

    assert {cls["label"]: cls["visible"] for cls in classes_of(doc)} == {"在来線改札内": True, "施設": False}


def test_alternate_scale_symbols_are_redrawn_like_the_main_symbol(theme: ColorTheme) -> None:
    cls = uv_class(["薄空"], "#E5F8FF")
    cls["alternateSymbols"] = [copy.deepcopy(cls["symbol"]), copy.deepcopy(cls["symbol"])]
    doc = layer_doc(renderer([cls]))

    retheme_document(doc, theme)

    (facilities,) = classes_of(doc)
    for alternate in facilities["alternateSymbols"]:
        layers = alternate["symbol"]["symbolLayers"]
        assert [(layer["type"], _hex(layer["color"])) for layer in layers] == [("CIMSolidStroke", OUTLINE), ("CIMSolidFill", "#DDEBEC")]


def test_a_renderer_whose_colours_are_overridden_at_draw_time_is_left_alone(theme: ColorTheme) -> None:
    ramped = renderer([uv_class(["薄空"], "#E5F8FF")], visualVariables=[{"type": "CIMColorVisualVariable"}])
    overridden_class = uv_class(["薄空"], "#E5F8FF")
    overridden_class["symbol"]["primitiveOverrides"] = [{"type": "CIMPrimitiveOverride", "propertyName": "Color"}]
    overridden = renderer([overridden_class])
    sized = renderer([uv_class(["薄空"], "#E5F8FF")], visualVariables=[{"type": "CIMSizeVisualVariable"}])
    doc = layer_doc(ramped, overridden, sized)
    before = copy.deepcopy(doc)

    changes = retheme_document(doc, theme)

    assert [(change.outcome, change.reason) for change in changes] == [
        ("left_alone", "unrecognised"),
        ("left_alone", "unrecognised"),
        ("rewritten", None),
    ]
    assert doc["layerDefinitions"][:2] == before["layerDefinitions"][:2]


def test_an_old_value_with_a_category_override_also_brings_the_class_its_override_writes(theme: ColorTheme) -> None:
    doc = layer_doc(renderer([uv_class(["濃鼠"], "#E5E6E6")]))

    retheme_document(doc, theme)

    drawn = {cls["label"]: (values_of(cls), fills(cls)) for cls in classes_of(doc)}
    assert drawn == {
        "改札外通路": (["改札外通路", "ラチ外白", "濃鼠", "道白"], ["#FFFFFF"]),
        "施設": (["施設", "薄空", "濃空", "トイレ"], ["#DDEBEC"]),
    }


def _without_classes(doc: dict[str, Any]) -> dict[str, Any]:
    stripped = copy.deepcopy(doc)
    for layer in stripped["layerDefinitions"]:
        for group in layer["renderer"]["groups"]:
            group.pop("classes")
    return stripped


def test_nothing_outside_the_rewritten_classes_changes(theme: ColorTheme) -> None:
    doc = tokyo_document()
    before = _without_classes(doc)

    retheme_document(doc, theme)

    assert _without_classes(doc) == before


def test_renderers_on_other_fields_or_with_several_fields_or_arcade_are_left_alone(theme: ColorTheme) -> None:
    classes = [uv_class(["黄"], "#FCFCE3"), uv_class(["白"], "#FFFFFF")]
    category = renderer(copy.deepcopy(classes), fields=["category"])
    image = renderer(copy.deepcopy(classes), fields=["image"])
    two_fields = renderer(copy.deepcopy(classes), fields=["color2", "category"])
    arcade = renderer(
        copy.deepcopy(classes),
        fields=[],
        valueExpressionInfo={"type": "CIMExpressionInfo", "expression": "$feature.COLOR2", "returnType": "Default"},
    )
    doc = layer_doc(category, image, two_fields, arcade)
    before = copy.deepcopy(doc)

    changes = retheme_document(doc, theme)

    assert doc == before
    assert [(c.layer, c.outcome, c.reason, c.classes_before, c.classes_after) for c in changes] == [
        ("Layer2", "left_alone", "several_fields", 2, 2),
        ("Layer3", "left_alone", "expression", 2, 2),
    ]


def test_a_renderer_that_knows_no_theme_value_or_draws_points_is_left_alone(theme: ColorTheme) -> None:
    point = uv_class(["黄"], "#FCFCE3")
    point["symbol"]["symbol"]["type"] = "CIMPointSymbol"
    doc = layer_doc(renderer([uv_class(["赤"], "#FF0000")]), renderer([point]))
    before = copy.deepcopy(doc)

    changes = retheme_document(doc, theme)

    assert doc == before
    assert [(c.outcome, c.reason) for c in changes] == [("left_alone", "no_known_values"), ("left_alone", "not_polygon")]


def test_a_second_pass_changes_nothing(theme: ColorTheme) -> None:
    for doc in (tokyo_document(), _mixed()):
        retheme_document(doc, theme)
        once = copy.deepcopy(doc)

        again = retheme_document(doc, theme)

        assert doc == once
        assert [change.outcome for change in again] == ["already_new"]
