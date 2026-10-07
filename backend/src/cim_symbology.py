"""Retheme ArcGIS Pro symbology: unique-value renderers keyed on the theme's field, in parsed CIM JSON.

Pure: no files, no zips, no ArcGIS. ``recolor.py`` parses ``.lyrx`` files and
``.aprx`` members and hands each document here.

A renderer keyed on ``color2`` alone is rebuilt as one class per theme area it
draws, in theme order. Each class lists the area's written value first and
then every old value whose default rule maps to the area, so a layer draws
the same before and after its data is converted. Values the theme does not
know stay in a copy of their old class. Running it on its own output changes
nothing, because the rebuilt classes rebuild to themselves.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator
import copy
from dataclasses import dataclass
from typing import Any

from backend.src.color_theme import AreaKey, ColorTheme, LeftAloneReason, RendererChange

_DEFAULT_WIDTH = 0.3
_STROKE = {
    "type": "CIMSolidStroke",
    "enable": True,
    "capStyle": "Round",
    "joinStyle": "Round",
    "lineStyle3D": "Strip",
    "miterLimit": 10,
    "width": _DEFAULT_WIDTH,
    "height3D": 1,
    "anchor3D": "Center",
}


@dataclass(frozen=True, slots=True)
class _Class:
    group: int
    node: dict[str, Any]
    values: tuple[str, ...]


def retheme_document(doc: Any, theme: ColorTheme) -> list[RendererChange]:
    """Rewrite, in place, every unique-value renderer in ``doc`` keyed on the theme's field alone.

    A renderer that names the field among several, or through an Arcade
    expression, is left alone and reported. Renderers on other fields are
    neither touched nor reported.
    """
    found = list(_renderers(doc, None))
    return [change for renderer, layer in found if (change := _retheme(renderer, layer, theme)) is not None]


def _renderers(node: Any, layer: str | None) -> Iterator[tuple[dict[str, Any], str | None]]:
    if isinstance(node, dict):
        kind = node.get("type")
        if isinstance(kind, str) and kind.endswith("Layer") and isinstance(node.get("name"), str):
            layer = node["name"]
        if kind == "CIMUniqueValueRenderer":
            yield node, layer
        for value in node.values():
            yield from _renderers(value, layer)
    elif isinstance(node, list):
        for value in node:
            yield from _renderers(value, layer)


def _names_field(renderer: dict[str, Any], field: str) -> bool:
    fields = renderer.get("fields") or []
    expression = renderer.get("valueExpressionInfo")
    in_expression = isinstance(expression, dict) and field.casefold() in str(expression.get("expression", "")).casefold()
    return in_expression or any(isinstance(name, str) and name.casefold() == field.casefold() for name in fields)


def _parse_classes(renderer: dict[str, Any]) -> list[_Class] | None:
    """Every class with its single-field values; None for any shape this module does not know how to rewrite."""
    groups = renderer.get("groups")
    if not isinstance(groups, list):
        return None
    classes: list[_Class] = []
    for index, group in enumerate(groups):
        if not isinstance(group, dict) or not isinstance(group.get("classes", []), list):
            return None
        for node in group.get("classes", []):
            if not isinstance(node, dict) or not isinstance(node.get("values"), list):
                return None
            symbol = node.get("symbol")
            if not isinstance(symbol, dict) or not isinstance(symbol.get("symbol"), dict):
                return None
            if not isinstance(symbol["symbol"].get("symbolLayers"), list):
                return None
            values = []
            for value in node["values"]:
                field_values = value.get("fieldValues") if isinstance(value, dict) else None
                if not isinstance(field_values, list) or len(field_values) != 1 or not isinstance(field_values[0], str):
                    return None
                values.append(field_values[0])
            classes.append(_Class(group=index, node=node, values=tuple(values)))
    return classes


def _left_alone(layer: str | None, reason: LeftAloneReason, classes: int) -> RendererChange:
    return RendererChange(
        layer=layer, outcome="left_alone", reason=reason, classes_before=classes, classes_after=classes, areas=(), kept=()
    )


def _class_count(renderer: dict[str, Any]) -> int:
    groups = renderer.get("groups")
    if not isinstance(groups, list):
        return 0
    return sum(len(group.get("classes") or []) for group in groups if isinstance(group, dict))


def _area_values(theme: ColorTheme) -> dict[AreaKey, tuple[str, ...]]:
    """Each area's written value, then the old values whose default rule maps to it, in rule order."""
    values: dict[AreaKey, list[str]] = {area.key: [area.value] for area in theme.areas}
    for rule in theme.rules:
        if rule.categories is None:
            values[rule.area.key].append(rule.old)
    return {key: tuple(items) for key, items in values.items()}


def _retheme(renderer: dict[str, Any], layer: str | None, theme: ColorTheme) -> RendererChange | None:
    if not _names_field(renderer, theme.field):
        return None
    before = _class_count(renderer)
    if renderer.get("valueExpressionInfo"):
        return _left_alone(layer, "expression", before)
    if len(renderer.get("fields") or []) != 1:
        return _left_alone(layer, "several_fields", before)
    classes = _parse_classes(renderer)
    if classes is None:
        return _left_alone(layer, "unrecognised", before)
    if any(cls.node["symbol"]["symbol"].get("type") != "CIMPolygonSymbol" for cls in classes):
        return _left_alone(layer, "not_polygon", before)
    if _colours_set_at_draw_time(renderer, classes):
        return _left_alone(layer, "unrecognised", before)

    area_values = _area_values(theme)
    area_of = {value: key for key, values in area_values.items() for value in values}
    first: dict[AreaKey, _Class] = {}
    shown: set[AreaKey] = set()
    for cls in classes:
        for value in cls.values:
            if value in area_of:
                first.setdefault(area_of[value], cls)
                if cls.node.get("visible") is not False:
                    shown.add(area_of[value])
    # A row an override converts is written another area's name; without that class it would fall to the default
    # symbol. A class that already draws the area stays its template, hence the second pass.
    for cls in classes:
        for value in cls.values:
            for rule in theme.rules:
                if rule.old == value and rule.categories is not None:
                    first.setdefault(rule.area.key, cls)
                    if cls.node.get("visible") is not False:
                        shown.add(rule.area.key)
    if not first:
        return _left_alone(layer, "no_known_values", before)

    width, stroke = _common_stroke(classes)
    rebuilt = [
        _area_class(first[area.key].node, area_values[area.key], area.hex, theme.outline.hex, stroke, width, area.key in shown)
        for area in theme.areas
        if area.key in first
    ]
    target = min(cls.group for cls in first.values())
    kept: dict[str, None] = {}
    residual: dict[int, list[dict[str, Any]]] = {}
    for cls in classes:
        unknown = []
        for index, value in enumerate(cls.values):
            if value not in area_of and value not in kept:
                kept[value] = None
                unknown.append(copy.deepcopy(cls.node["values"][index]))
        if len(unknown) == len(cls.values):
            residual.setdefault(cls.group, []).append(cls.node)
        elif unknown:
            label = "; ".join(value["fieldValues"][0] for value in unknown)
            residual.setdefault(cls.group, []).append({**cls.node, "label": label, "values": unknown})

    groups = []
    for index, group in enumerate(renderer["groups"]):
        group_classes = (rebuilt if index == target else []) + residual.get(index, [])
        if group_classes:
            groups.append({**group, "classes": group_classes})
        elif not group.get("classes"):
            groups.append(group)
    changed = groups != renderer["groups"]
    if changed:
        renderer["groups"] = groups
    return RendererChange(
        layer=layer,
        outcome="rewritten" if changed else "already_new",
        reason=None,
        classes_before=before,
        classes_after=_class_count(renderer),
        areas=tuple(area.key for area in theme.areas if area.key in first),
        kept=tuple(kept),
    )


def _colours_set_at_draw_time(renderer: dict[str, Any], classes: list[_Class]) -> bool:
    """A colour visual variable or a primitive override repaints a class when it draws, whatever its symbol says."""
    variables = renderer.get("visualVariables")
    if isinstance(variables, list) and any(
        isinstance(item, dict) and item.get("type") == "CIMColorVisualVariable" for item in variables
    ):
        return True
    for cls in classes:
        alternates = cls.node.get("alternateSymbols")
        references = [cls.node["symbol"], *(alternates if isinstance(alternates, list) else [])]
        if any(isinstance(reference, dict) and reference.get("primitiveOverrides") for reference in references):
            return True
    return False


def _common_stroke(classes: list[_Class]) -> tuple[float, dict[str, Any]]:
    """The width most strokes in the renderer have (the first seen on a tie), and a stroke of that width to copy."""
    strokes = [
        layer
        for cls in classes
        for layer in cls.node["symbol"]["symbol"]["symbolLayers"]
        if isinstance(layer, dict)
        and layer.get("type") == "CIMSolidStroke"
        and layer.get("enable") is not False
        and isinstance(layer.get("width"), (int, float))
    ]
    if not strokes:
        return _DEFAULT_WIDTH, _STROKE
    width = Counter(stroke["width"] for stroke in strokes).most_common(1)[0][0]
    return width, next(stroke for stroke in strokes if stroke["width"] == width)


def _area_class(
    template: dict[str, Any],
    values: tuple[str, ...],
    fill_hex: str,
    outline_hex: str,
    stroke: dict[str, Any],
    width: float,
    visible: bool,
) -> dict[str, Any]:
    """The template class drawn in the area's fill, labelled and matched by the area's values; key order kept.

    ``visible`` is whether any class it replaces was shown: hiding the merged class because its template was
    hidden would hide rows that drew before.
    """
    replaced: dict[str, Any] = {
        "label": values[0],
        "symbol": _redrawn(template["symbol"], fill_hex, outline_hex, stroke, width),
        "values": [{"type": "CIMUniqueValue", "fieldValues": [value]} for value in values],
    }
    if "visible" in template or not visible:
        replaced["visible"] = visible
    # ArcGIS draws an alternate symbol in its own scale range, where the old colours would otherwise come back.
    alternates = template.get("alternateSymbols")
    if isinstance(alternates, list):
        replaced["alternateSymbols"] = [
            _redrawn(item, fill_hex, outline_hex, stroke, width) if _is_polygon_reference(item) else copy.deepcopy(item)
            for item in alternates
        ]
    result = {key: replaced.get(key, copy.deepcopy(value)) for key, value in template.items()}
    return {**result, **{key: value for key, value in replaced.items() if key not in result}}


def _is_polygon_reference(item: Any) -> bool:
    symbol = item.get("symbol") if isinstance(item, dict) else None
    return isinstance(symbol, dict) and symbol.get("type") == "CIMPolygonSymbol" and isinstance(symbol.get("symbolLayers"), list)


def _redrawn(reference: dict[str, Any], fill_hex: str, outline_hex: str, stroke: dict[str, Any], width: float) -> dict[str, Any]:
    """A copy of a polygon symbol reference in the area's fill and the theme's outline."""
    symbol = copy.deepcopy(reference)
    layers = symbol["symbol"]["symbolLayers"]
    if not _draws(layers, "CIMSolidStroke"):
        # Index 0 draws on top; a stroke under the fill would be hidden by it.
        layers.insert(0, {**copy.deepcopy(stroke), "width": width, "enable": True})
    if not _draws(layers, "CIMSolidFill"):
        # A hatch or picture fill carries no area colour; the last layer draws underneath the rest.
        layers.append({"type": "CIMSolidFill", "enable": True, "color": None})
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        if layer.get("type") == "CIMSolidFill":
            layer["color"] = _rgb(fill_hex, layer.get("color"))
        elif layer.get("type") == "CIMSolidStroke":
            layer["color"] = _rgb(outline_hex, layer.get("color"))
    return symbol


def _draws(layers: list[Any], kind: str) -> bool:
    """Whether a layer of this type is switched on; a disabled layer draws nothing, so it does not count."""
    return any(isinstance(layer, dict) and layer.get("type") == kind and layer.get("enable") is not False for layer in layers)


def _rgb(hex_colour: str, previous: Any) -> dict[str, Any]:
    """An RGB colour that keeps the previous colour's transparency when it was RGB, unless that hid it entirely."""
    alpha = 100
    if isinstance(previous, dict) and previous.get("type") == "CIMRGBColor":
        old = previous.get("values")
        if isinstance(old, list) and len(old) == 4 and isinstance(old[3], (int, float)) and old[3] > 0:
            alpha = old[3]
    red, green, blue = (int(hex_colour[index : index + 2], 16) for index in (1, 3, 5))
    return {"type": "CIMRGBColor", "values": [red, green, blue, alpha]}
