"""Retheme ArcGIS Pro symbology: unique-value renderers keyed on one of the theme's two fields, in parsed CIM JSON.

Pure: no files, no zips, no ArcGIS. ``recolor.py`` parses ``.lyrx`` files and
``.aprx`` members and hands each document here. ``layer_document`` goes the
other way and writes a layer file for a shapefile that has none; retheming
what it wrote changes nothing.

A renderer keyed on ``color2`` alone is rebuilt as one class per theme area it
draws, in theme order. Each class lists the area's written value first and
then every old value whose default rule maps to the area, so a layer draws
the same before and after its data is converted.

A renderer keyed on ``category`` alone (the Revit/IMDF stations, which have no
``color2``) is rebuilt the same way from the theme's category table. Its data
is never rewritten, so each class lists only the categories the renderer
already drew.

Either way, values the theme does not know stay in a copy of their old class,
and running it on its own output changes nothing, because the rebuilt classes
rebuild to themselves.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator, Mapping
import copy
import re
from dataclasses import dataclass
import json
from typing import Any

from backend.src.color_theme import (
    AreaKey,
    ColorTheme,
    LayerStyle,
    LeftAloneReason,
    RendererChange,
    category_classes,
    colour_classes,
)

def _stroke(width: float) -> dict[str, Any]:
    """A solid stroke as Pro saves one, in Pro's key order and without a colour."""
    return {
        "type": "CIMSolidStroke",
        "enable": True,
        "capStyle": "Round",
        "joinStyle": "Round",
        "lineStyle3D": "Strip",
        "miterLimit": 10,
        "width": width,
        "height3D": 1,
        "anchor3D": "Center",
    }


@dataclass(frozen=True, slots=True)
class _Class:
    group: int
    node: dict[str, Any]
    values: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _Keying:
    """One field a renderer can be keyed on, and how its values become theme areas."""

    field: str
    area_of: Mapping[str, AreaKey]
    """Every value the theme knows in this field, to the area whose class matches it."""
    listed: Mapping[AreaKey, tuple[str, ...]] | None
    """The values an area's class always lists, because converting the data writes them.

    None where the data is not converted: the class lists the values the renderer already matched.
    """
    brings: Mapping[str, tuple[AreaKey, ...]]
    """Areas a value's rows can be converted to besides its own, whose classes must then exist too."""
    incidental: bool
    """The field colours many layers that are none of this tool's business (fixtures, amenity points).

    Such a renderer is taken up only when it is keyed on the field alone, draws polygons and holds a
    value the theme knows; otherwise it is neither touched nor reported.
    """

    def claims(self, renderer: dict[str, Any]) -> bool:
        if not self.incidental:
            return _names_field(renderer, self.field)
        fields = renderer.get("fields")
        return (
            not renderer.get("valueExpressionInfo")
            and isinstance(fields, list)
            and len(fields) == 1
            and isinstance(fields[0], str)
            and fields[0].casefold() == self.field.casefold()
        )


def _keyings(theme: ColorTheme) -> tuple[_Keying, _Keying]:
    """The colour field first: a renderer that names it is never taken for a category renderer."""
    listed = {item.area.key: item.values for item in colour_classes(theme)}
    brings: dict[str, list[AreaKey]] = {}
    for rule in theme.rules:
        if rule.categories is not None:
            brings.setdefault(rule.old, []).append(rule.area.key)
    colour = _Keying(
        field=theme.field,
        area_of={value: key for key, values in listed.items() for value in values},
        listed=listed,
        brings={old: tuple(keys) for old, keys in brings.items()},
        incidental=False,
    )
    category = _Keying(
        field=theme.category_field,
        area_of={value: item.area.key for item in category_classes(theme) for value in item.values},
        listed=None,
        brings={},
        incidental=True,
    )
    return colour, category


def retheme_document(doc: Any, theme: ColorTheme) -> list[RendererChange]:
    """Rewrite, in place, every unique-value renderer in ``doc`` keyed on the theme's field or category field alone.

    A renderer that names the colour field among several, or through an
    Arcade expression, is left alone and reported. Renderers on other fields
    are neither touched nor reported.
    """
    keyings = _keyings(theme)
    found = list(_renderers(doc, None, False))
    return [
        change
        for renderer, layer, units in found
        if (change := _retheme(renderer, layer, units, theme, keyings)) is not None
    ]


_UNIT_WORD = re.compile(r"(?<![A-Za-z])units?(?![A-Za-z])", re.IGNORECASE)
"""The category table is the unit catalogue's. A section or facility layer shares words with it (walkway, platform,
unspecified) and means something else by them, so only a layer named for units, or reading a units dataset, is taken."""


def is_unit_layer(*names: str) -> bool:
    """Whether a layer's name, dataset or file name says it holds units: "unit" or "units" as a word of its own."""
    return any(_UNIT_WORD.search(name) for name in names)


def _renderers(node: Any, layer: str | None, units: bool) -> Iterator[tuple[dict[str, Any], str | None, bool]]:
    if isinstance(node, dict):
        kind = node.get("type")
        if isinstance(kind, str) and kind.endswith("Layer") and isinstance(node.get("name"), str):
            layer = node["name"]
            table = node.get("featureTable")
            connection = table.get("dataConnection") if isinstance(table, dict) else None
            dataset = connection.get("dataset") if isinstance(connection, dict) else None
            units = is_unit_layer(layer, dataset if isinstance(dataset, str) else "")
        if kind == "CIMUniqueValueRenderer":
            yield node, layer, units
        for value in node.values():
            yield from _renderers(value, layer, units)
    elif isinstance(node, list):
        for value in node:
            yield from _renderers(value, layer, units)


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


def _class_count(renderer: dict[str, Any]) -> int:
    groups = renderer.get("groups")
    if not isinstance(groups, list):
        return 0
    return sum(len(group.get("classes") or []) for group in groups if isinstance(group, dict))


def _draws_polygons(classes: list[_Class]) -> bool:
    return all(cls.node["symbol"]["symbol"].get("type") == "CIMPolygonSymbol" for cls in classes)


def _retheme(
    renderer: dict[str, Any], layer: str | None, units: bool, theme: ColorTheme, keyings: tuple[_Keying, ...]
) -> RendererChange | None:
    keying = next((item for item in keyings if item.claims(renderer)), None)
    if keying is None:
        return None
    before = _class_count(renderer)

    def left_alone(reason: LeftAloneReason) -> RendererChange:
        return RendererChange(
            layer=layer,
            field=keying.field,
            outcome="left_alone",
            reason=reason,
            classes_before=before,
            classes_after=before,
            areas=(),
            kept=(),
        )

    if renderer.get("valueExpressionInfo"):
        return left_alone("expression")
    if len(renderer.get("fields") or []) != 1:
        return left_alone("several_fields")
    classes = _parse_classes(renderer)
    area_of = keying.area_of
    if keying.incidental:
        known = classes is not None and any(value in area_of for cls in classes for value in cls.values)
        if not units or classes is None or not known or not _draws_polygons(classes):
            return None
    if classes is None:
        return left_alone("unrecognised")
    if not _draws_polygons(classes):
        return left_alone("not_polygon")
    if _colours_set_at_draw_time(renderer, classes):
        return left_alone("unrecognised")

    first: dict[AreaKey, _Class] = {}
    shown: set[AreaKey] = set()
    matched: dict[AreaKey, dict[str, None]] = {}
    for cls in classes:
        for value in cls.values:
            if value in area_of:
                first.setdefault(area_of[value], cls)
                matched.setdefault(area_of[value], {})[value] = None
                if cls.node.get("visible") is not False:
                    shown.add(area_of[value])
    # A row an override converts is written another area's name; without that class it would fall to the default
    # symbol. A class that already draws the area stays its template, hence the second pass.
    for cls in classes:
        for value in cls.values:
            for area_key in keying.brings.get(value, ()):
                first.setdefault(area_key, cls)
                if cls.node.get("visible") is not False:
                    shown.add(area_key)
    if not first:
        return left_alone("no_known_values")

    width, stroke = _common_stroke(classes, theme.outline.width_pt)
    rebuilt = [
        _area_class(
            first[area.key].node,
            area.value,
            tuple(matched[area.key]) if keying.listed is None else keying.listed[area.key],
            area.hex,
            theme.outline.hex,
            stroke,
            width,
            area.key in shown,
        )
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
        field=keying.field,
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


def _common_stroke(classes: list[_Class], fallback: float) -> tuple[float, dict[str, Any]]:
    """The width most strokes in the renderer have (the first seen on a tie), and a stroke of that width to copy.

    A renderer that draws no stroke at all gets one of the ``fallback`` width.
    """
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
        return fallback, _stroke(fallback)
    width = Counter(stroke["width"] for stroke in strokes).most_common(1)[0][0]
    return width, next(stroke for stroke in strokes if stroke["width"] == width)


def _area_class(
    template: dict[str, Any],
    label: str,
    values: tuple[str, ...],
    fill_hex: str,
    outline_hex: str,
    stroke: dict[str, Any],
    width: float,
    visible: bool,
) -> dict[str, Any]:
    """The template class drawn in the area's fill, labelled with the area and matched by its values; key order kept.

    ``visible`` is whether any class it replaces was shown: hiding the merged class because its template was
    hidden would hide rows that drew before.
    """
    replaced: dict[str, Any] = {
        "label": label,
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


def layer_file_text(doc: Any) -> str:
    """Pro's own layout for a layer file. JSON escapes any newline inside a string, so only the layout's change."""
    return json.dumps(doc, ensure_ascii=False, indent=2, separators=(",", " : ")).replace("\n", "\r\n")


def layer_document(theme: ColorTheme, style: LayerStyle, *, name: str, shapefile: str) -> dict[str, Any]:
    """A layer file for the shapefile beside it: the fewest CIM properties that name the data and draw it.

    Written by hand and not copied from a project's layer, so it carries no
    field list, labelling or scale range that might not hold for this
    shapefile. ``shapefile`` is the ``.shp``'s file name; the connection is
    relative, so the pair can be moved together.
    """
    uri = "CIMPATH=map/layer.json"
    return {
        "type": "CIMLayerDocument",
        "version": "3.0.0",
        "layers": [uri],
        "layerDefinitions": [
            {
                "type": "CIMFeatureLayer",
                "name": name,
                "uRI": uri,
                "layerType": "Operational",
                "showLegends": True,
                "visibility": True,
                "showPopups": True,
                "featureTable": {
                    "type": "CIMFeatureTable",
                    "dataConnection": {
                        "type": "CIMStandardDataConnection",
                        "workspaceConnectionString": "DATABASE=.",
                        "workspaceFactory": "Shapefile",
                        "dataset": shapefile,
                        "datasetType": "esriDTFeatureClass",
                    },
                },
                "selectable": True,
                "renderer": {
                    "type": "CIMUniqueValueRenderer",
                    "defaultLabel": theme.other.label,
                    "defaultSymbol": _polygon_symbol(theme, theme.other.hex),
                    "defaultSymbolPatch": "Default",
                    "fields": [style.field],
                    "groups": [
                        {
                            "type": "CIMUniqueValueGroup",
                            "classes": [
                                {
                                    "type": "CIMUniqueValueClass",
                                    "label": item.area.value,
                                    "patch": "Default",
                                    "symbol": _polygon_symbol(theme, item.area.hex),
                                    "values": [{"type": "CIMUniqueValue", "fieldValues": [value]} for value in item.values],
                                    "visible": True,
                                }
                                for item in style.classes
                            ],
                            "heading": style.field,
                        }
                    ],
                    "useDefaultSymbol": True,
                    "polygonSymbolColorTarget": "Fill",
                },
            }
        ],
    }


def _polygon_symbol(theme: ColorTheme, fill_hex: str) -> dict[str, Any]:
    return {
        "type": "CIMSymbolReference",
        "symbol": {
            "type": "CIMPolygonSymbol",
            "symbolLayers": [
                {**_stroke(theme.outline.width_pt), "color": _rgb(theme.outline.hex, None)},
                {"type": "CIMSolidFill", "enable": True, "color": _rgb(fill_hex, None)},
            ],
        },
    }
