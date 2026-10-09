"""The station colour theme: which old ``color2`` values, and which categories, become which areas.

Format-neutral on purpose. Nothing here knows about DBF bytes, zips or GDAL: a
layer is an id plus its decoded rows and its target field's width, and the
answer is a report plus per-layer edits. ``recolor.py`` feeds it from
shapefiles, and ``gdb.py`` from File Geodatabases, as the same ``LayerInput``s.
Layer files and projects are rethemed by ``cim_symbology.py`` and only
reported here. A station drawn by ``category`` has no ``color2`` to rewrite,
so its data is never edited and only its renderers change.

``colour_classes`` and ``category_classes`` are the one answer to "which
values does an area's class match". The retheming of existing renderers and
the style files written beside a shapefile both draw from them.

``load_color_theme`` checks the invariants once, at startup. The one that
matters most: the old vocabulary and the written vocabulary are disjoint, so
everything the tool writes classifies as ``already_new`` next time and a
second run changes nothing.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
import json
from pathlib import Path
import re
from types import MappingProxyType
from typing import Any, Literal, NewType

AreaKey = NewType("AreaKey", str)
RuleId = NewType("RuleId", int)

Keep = Literal["empty", "already_new", "unmapped"]
"""Why ``classify`` leaves a value alone."""

Fate = Literal["recolor", "already_new", "empty", "unmapped", "too_wide", "undecodable"]
"""What happens to one row. Only ``recolor`` writes."""

SkipReason = Literal["field_not_text", "unreadable", "gdb_unavailable"]
"""``gdb_unavailable``: no Python with GDAL's ``osgeo`` was found, so a geodatabase cannot be edited."""

RendererOutcome = Literal["rewritten", "already_new", "left_alone"]
"""What retheming did to one unique-value renderer keyed on the field or the category field."""

LeftAloneReason = Literal["several_fields", "expression", "not_polygon", "unrecognised", "no_known_values", "unreadable"]
"""Why a renderer that names the field was left as it was. ``unreadable``: an ``.aprx`` member that is not JSON."""

WidthUnit = Literal["bytes", "characters"]
"""A DBF field counts bytes of its codec. A geodatabase text field counts characters, and 0 means no limit."""


@dataclass(frozen=True, slots=True)
class Bilingual:
    en: str
    ja: str


@dataclass(frozen=True, slots=True)
class Area:
    """One row of the Figma New table."""

    key: AreaKey
    name: Bilingual
    value: str
    """The text written into the field."""
    spec: str
    hex: str


@dataclass(frozen=True, slots=True)
class Outline:
    spec: str
    hex: str
    width_pt: float
    """The stroke width of a symbol this tool draws from nothing; a rethemed renderer keeps its own widths."""


@dataclass(frozen=True, slots=True)
class OtherSymbol:
    """How a generated style draws a value the theme does not know, so that no feature goes undrawn."""

    name: Bilingual
    hex: str

    @property
    def label(self) -> str:
        """One legend entry serves both languages, as the area names do."""
        return f"{self.name.ja} ({self.name.en})"


@dataclass(frozen=True, slots=True)
class Rule:
    id: RuleId
    """Position in the config's ``rules`` list."""
    old: str
    old_hex: str | None
    scope: Bilingual
    area: Area
    categories: frozenset[str] | None
    """None for the old value's default rule; otherwise the categories this override claims."""


@dataclass(frozen=True, slots=True)
class OldValue:
    default: Rule
    by_category: Mapping[str, Rule]


@dataclass(frozen=True, slots=True)
class ColorTheme:
    field: str
    category_field: str
    outline: Outline
    """The Figma 枠線 colour every area is outlined in, in layer files, projects and style files."""
    other: OtherSymbol
    areas: tuple[Area, ...]
    rules: tuple[Rule, ...]
    new_values: frozenset[str]
    by_old: Mapping[str, OldValue]
    category_areas: Mapping[str, Area]
    """The area a unit of this category is drawn as, where a layer is coloured by ``category_field`` alone.

    In config order. A category that is absent keeps the symbol it has.
    """

    def classify(self, value: str, category: str | None) -> Rule | Keep:
        """The rule that rewrites ``value``, or why it stays.

        ``value`` arrives decoded with trailing blanks stripped. A leading
        blank, a different case or a near match is not in the table, so it
        is reported rather than guessed.
        """
        if not value:
            return "empty"
        if value in self.new_values:
            return "already_new"
        entry = self.by_old.get(value)
        if entry is None:
            return "unmapped"
        if category is None:
            return entry.default
        return entry.by_category.get(category, entry.default)


_HEX = re.compile(r"#[0-9A-Fa-f]{6}")
_TOP_KEYS = {"source", "field", "category_field", "outline", "other", "areas", "rules", "category_areas"}
_OUTLINE_KEYS = {"spec", "hex", "width_pt"}
_OTHER_KEYS = {"name", "hex"}
_AREA_KEYS = {"key", "name", "value", "spec", "hex"}
_RULE_KEYS = {"old", "old_hex", "scope", "area", "categories"}
_CATEGORY_AREA_KEYS = {"area", "categories"}
_BILINGUAL_KEYS = {"en", "ja"}


def _keys(obj: Any, allowed: set[str], where: str, *, optional: frozenset[str] = frozenset()) -> dict[str, Any]:
    if not isinstance(obj, dict):
        raise ValueError(f"{where} must be an object")
    unknown = set(obj) - allowed
    if unknown:
        raise ValueError(f"{where} has unknown key(s): {', '.join(sorted(unknown))}")
    missing = allowed - optional - set(obj)
    if missing:
        raise ValueError(f"{where} is missing: {', '.join(sorted(missing))}")
    return obj


def _text(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError(f"{where} must be non-blank text without surrounding spaces")
    return value


def _hex(value: Any, where: str) -> str:
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        raise ValueError(f"{where} must be a #RRGGBB colour")
    return value.upper()


def _bilingual(value: Any, where: str) -> Bilingual:
    obj = _keys(value, _BILINGUAL_KEYS, where)
    return Bilingual(en=_text(obj["en"], f"{where}.en"), ja=_text(obj["ja"], f"{where}.ja"))


def _outline(value: Any, where: str) -> Outline:
    obj = _keys(value, _OUTLINE_KEYS, where)
    width = obj["width_pt"]
    if isinstance(width, bool) or not isinstance(width, (int, float)) or width <= 0:
        raise ValueError(f"{where}.width_pt must be a positive number of points")
    return Outline(spec=_text(obj["spec"], f"{where}.spec"), hex=_hex(obj["hex"], f"{where}.hex"), width_pt=width)


def _other(value: Any, where: str) -> OtherSymbol:
    obj = _keys(value, _OTHER_KEYS, where)
    return OtherSymbol(name=_bilingual(obj["name"], f"{where}.name"), hex=_hex(obj["hex"], f"{where}.hex"))


def load_color_theme(path: Path) -> ColorTheme:
    """Parse and validate the theme; raises ValueError naming the broken invariant.

    Called once in the app lifespan, so a broken table stops the server at
    boot instead of surfacing on an operator's upload.
    """
    raw = _keys(json.loads(path.read_text(encoding="utf-8")), _TOP_KEYS, "theme", optional=frozenset({"source"}))
    areas: dict[str, Area] = {}
    for index, item in enumerate(raw["areas"]):
        where = f"areas[{index}]"
        obj = _keys(item, _AREA_KEYS, where)
        key = AreaKey(_text(obj["key"], f"{where}.key"))
        if key in areas:
            raise ValueError(f"{where}: area key {key!r} is used twice")
        areas[key] = Area(
            key=key,
            name=_bilingual(obj["name"], f"{where}.name"),
            value=_text(obj["value"], f"{where}.value"),
            spec=_text(obj["spec"], f"{where}.spec"),
            hex=_hex(obj["hex"], f"{where}.hex"),
        )
    written = Counter(area.value for area in areas.values())
    if repeated := sorted(value for value, count in written.items() if count > 1):
        raise ValueError(f"Two areas write the same value: {', '.join(repeated)}")

    rules: list[Rule] = []
    for index, item in enumerate(raw["rules"]):
        where = f"rules[{index}]"
        obj = _keys(item, _RULE_KEYS, where, optional=frozenset({"categories"}))
        area_key = obj["area"]
        if area_key not in areas:
            raise ValueError(f"{where} names unknown area {area_key!r}")
        categories = obj.get("categories")
        if categories is not None:
            if not isinstance(categories, list) or not categories:
                raise ValueError(f"{where}.categories must be a non-empty list")
            categories = frozenset(_text(code, f"{where}.categories") for code in categories)
        rules.append(
            Rule(
                id=RuleId(index),
                old=_text(obj["old"], f"{where}.old"),
                old_hex=None if obj["old_hex"] is None else _hex(obj["old_hex"], f"{where}.old_hex"),
                scope=_bilingual(obj["scope"], f"{where}.scope"),
                area=areas[area_key],
                categories=categories,
            )
        )

    by_old: dict[str, OldValue] = {}
    for old in dict.fromkeys(rule.old for rule in rules):
        same = [rule for rule in rules if rule.old == old]
        defaults = [rule for rule in same if rule.categories is None]
        if len(defaults) != 1:
            raise ValueError(f"Old value {old!r} needs exactly one rule without categories, has {len(defaults)}")
        by_category: dict[str, Rule] = {}
        for rule in same:
            for category in sorted(rule.categories or ()):
                if category in by_category:
                    raise ValueError(f"Old value {old!r} claims category {category} in two rules")
                by_category[category] = rule
        by_old[old] = OldValue(default=defaults[0], by_category=MappingProxyType(by_category))

    new_values = frozenset(written)
    if clash := sorted(new_values & set(by_old)):
        raise ValueError(f"Written values must not also be old values (a second run would rewrite them): {', '.join(clash)}")

    category_areas: dict[str, Area] = {}
    listed: set[str] = set()
    for index, item in enumerate(raw["category_areas"]):
        where = f"category_areas[{index}]"
        obj = _keys(item, _CATEGORY_AREA_KEYS, where)
        area_key = obj["area"]
        if area_key not in areas:
            raise ValueError(f"{where} names unknown area {area_key!r}")
        if area_key in listed:
            raise ValueError(f"{where}: area {area_key!r} is listed twice")
        listed.add(area_key)
        categories = obj["categories"]
        if not isinstance(categories, list) or not categories:
            raise ValueError(f"{where}.categories must be a non-empty list")
        for category in categories:
            if _text(category, f"{where}.categories") in category_areas:
                raise ValueError(f"{where}: category {category!r} is listed twice")
            category_areas[category] = areas[area_key]

    field = _text(raw["field"], "field")
    category_field = _text(raw["category_field"], "category_field")
    if field.casefold() == category_field.casefold():
        # A renderer keyed on that one field would belong to both tables.
        raise ValueError(f"field and category_field must differ, both are {field!r}")
    return ColorTheme(
        field=field,
        category_field=category_field,
        outline=_outline(raw["outline"], "outline"),
        other=_other(raw["other"], "other"),
        areas=tuple(areas.values()),
        rules=tuple(rules),
        new_values=new_values,
        by_old=MappingProxyType(by_old),
        category_areas=MappingProxyType(category_areas),
    )


@dataclass(frozen=True, slots=True)
class AreaClass:
    """One class of a renderer: the area it draws and the field values that select it."""

    area: Area
    values: tuple[str, ...]


def colour_classes(theme: ColorTheme) -> tuple[AreaClass, ...]:
    """A class per area for a renderer on the colour field, in theme order.

    Each lists the area's written value and then every old value whose
    default rule maps to it, so one renderer draws data before and after it
    is converted. A category override is not a value of the field, so a row
    it will convert draws as its default rule's area until then.
    """
    return tuple(
        AreaClass(
            area=area,
            values=(area.value, *(rule.old for rule in theme.rules if rule.area is area and rule.categories is None)),
        )
        for area in theme.areas
    )


def category_classes(theme: ColorTheme) -> tuple[AreaClass, ...]:
    """A class per area the category table draws, in theme order, each with its categories in table order."""
    drawn_as: dict[AreaKey, list[str]] = {}
    for category, area in theme.category_areas.items():
        drawn_as.setdefault(area.key, []).append(category)
    return tuple(AreaClass(area=area, values=tuple(drawn_as[area.key])) for area in theme.areas if area.key in drawn_as)


@dataclass(frozen=True, slots=True)
class LayerStyle:
    """How a style file written beside a polygon shapefile classes it."""

    field: str
    classes: tuple[AreaClass, ...]


def layer_style(theme: ColorTheme, *, has_field: bool, categories: Iterable[str] | None) -> LayerStyle | None:
    """The style for a table: by the colour field where it has one, else by a category the table knows.

    ``categories`` are the table's category values, or None without a text
    category field; they are only read when the colour field is absent.
    None when the theme has nothing to colour the layer by.
    """
    if has_field:
        return LayerStyle(field=theme.field, classes=colour_classes(theme))
    if categories is not None and any(category in theme.category_areas for category in categories):
        return LayerStyle(field=theme.category_field, classes=category_classes(theme))
    return None


@dataclass(frozen=True, slots=True)
class Row:
    index: int
    """Addresses the source row: the DBF record number, counting deleted records, or the geodatabase FID."""
    value: str | None
    """Decoded target field, trailing blanks stripped. None when the bytes do not decode."""
    category: str | None


@dataclass(frozen=True, slots=True)
class Encoding:
    codec: str
    source: str
    """Where the codec came from: "cpg", "ldid", "sniffed" or "ascii" for a shapefile, "gdb" for a geodatabase."""


@dataclass(frozen=True, slots=True)
class LayerInput:
    id: str
    """Shown to the operator: the .dbf's path inside the upload, or ``<gdb path>/<feature class>``."""
    rows: Sequence[Row]
    width: int
    width_unit: WidthUnit
    encoding: Encoding


@dataclass(frozen=True, slots=True)
class SkippedLayer:
    """A layer that names the field but cannot be edited safely; it passes through untouched."""

    id: str
    reason: SkipReason


@dataclass(frozen=True, slots=True)
class RuleLine:
    """One row of the change table. Every rule appears, in config order, even at zero."""

    rule: RuleId
    old: str
    old_hex: str | None
    scope: Bilingual
    categories: tuple[str, ...] | None
    area: AreaKey
    area_name: Bilingual
    value: str
    spec: str
    hex: str
    rows: int
    """Rows this rule rewrites."""
    too_wide: int
    """Rows this rule matched but could not write: the value does not fit the field."""


@dataclass(frozen=True, slots=True)
class UnmappedLine:
    value: str
    rows: int
    layers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Counts:
    rows: int
    recolor: int
    already_new: int
    empty: int
    unmapped: int
    too_wide: int
    undecodable: int


@dataclass(frozen=True, slots=True)
class LayerLine:
    id: str
    encoding: Encoding
    width: int
    width_unit: WidthUnit
    counts: Counts


@dataclass(frozen=True, slots=True)
class SkippedLine:
    id: str
    reason: SkipReason


@dataclass(frozen=True, slots=True)
class RendererChange:
    """One unique-value renderer in a layer file or project that this tool takes up."""

    layer: str | None
    """The enclosing layer's name; the member's path when an ``.aprx`` member could not be parsed."""
    field: str | None
    """The theme field the renderer is keyed on: the colour field or the category field. None for an unparsed member."""
    outcome: RendererOutcome
    reason: LeftAloneReason | None
    """Set exactly when ``outcome`` is ``left_alone``."""
    classes_before: int
    classes_after: int
    areas: tuple[AreaKey, ...]
    """The theme areas the renderer draws after the rewrite, in theme order."""
    kept: tuple[str, ...]
    """Class values the theme does not know, kept in their own classes with their old symbols."""


SymbologyKind = Literal["lyrx", "aprx"]


@dataclass(frozen=True, slots=True)
class CategoryAreaLine:
    """One area of the category table, for the page to show beside the colour table."""

    area: AreaKey
    area_name: Bilingual
    value: str
    """The area's written value, which labels its class."""
    spec: str
    hex: str
    categories: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SymbologyLine:
    """One ``.lyrx`` or ``.aprx`` in the upload. An unreadable file comes back untouched."""

    path: str
    kind: SymbologyKind
    unreadable: bool
    renderers: tuple[RendererChange, ...]
    """Renderers that name the colour field, and polygon renderers keyed on the category field alone that hold
    a category the theme knows. Other renderers are not listed."""


StyleKind = Literal["qml", "lyrx"]
"""A QGIS layer style, loaded with the shapefile of the same name, or an ArcGIS Pro layer file pointing at it."""

StyleOutcome = Literal["added", "kept"]
"""``kept``: the upload already holds a file of that name, which comes back instead of a generated one."""


@dataclass(frozen=True, slots=True)
class StyleFileLine:
    """One style file beside a polygon shapefile the theme can colour."""

    path: str
    kind: StyleKind
    layer: str
    """The shapefile it styles, as a path inside the upload."""
    field: str
    """The field its renderer is keyed on: the colour field or the category field."""
    classes: tuple[AreaKey, ...]
    """The areas it draws, one class each, in theme order. Any other value draws as the theme's ``other`` symbol."""
    outcome: StyleOutcome


@dataclass(frozen=True, slots=True)
class ThemeReport:
    field: str
    category_field: str
    category_areas: tuple[CategoryAreaLine, ...]
    """The category table: each area that categories are drawn as, in theme order."""
    rules: tuple[RuleLine, ...]
    unmapped: tuple[UnmappedLine, ...]
    """Most rows first."""
    layers: tuple[LayerLine, ...]
    skipped: tuple[SkippedLine, ...]
    totals: Counts
    symbology: tuple[SymbologyLine, ...]
    style_files: tuple[StyleFileLine, ...]
    """What asking for style files adds, and the files of those names the upload already has."""


@dataclass(frozen=True, slots=True)
class ThemePlan:
    report: ThemeReport
    edits: Mapping[str, Mapping[int, str]]
    """Layer id to {row index: new text}. Only ``recolor`` rows appear; a layer with none is absent."""


def _counts(fates: Counter[Fate]) -> Counts:
    return Counts(
        rows=sum(fates.values()),
        recolor=fates["recolor"],
        already_new=fates["already_new"],
        empty=fates["empty"],
        unmapped=fates["unmapped"],
        too_wide=fates["too_wide"],
        undecodable=fates["undecodable"],
    )


def _fits(value: str, layer: LayerInput) -> bool:
    if layer.width_unit == "characters":
        return layer.width == 0 or len(value) <= layer.width
    try:
        return len(value.encode(layer.encoding.codec)) <= layer.width
    except UnicodeEncodeError:
        return False


def plan(
    theme: ColorTheme,
    layers: Sequence[LayerInput | SkippedLayer],
    symbology: Sequence[SymbologyLine] = (),
    style_files: Sequence[StyleFileLine] = (),
) -> ThemePlan:
    """Classify every row of every layer once; the report and the edits come from that one pass.

    A matched rule whose value is wider than the field, counted in the
    layer's own unit, is ``too_wide``: reported, never truncated. Pure, so the inspect
    call and the convert call cannot disagree.
    """
    rule_rows: Counter[RuleId] = Counter()
    rule_too_wide: Counter[RuleId] = Counter()
    unmapped_rows: Counter[str] = Counter()
    unmapped_layers: dict[str, dict[str, None]] = {}
    layer_lines: list[LayerLine] = []
    skipped: list[SkippedLine] = []
    edits: dict[str, Mapping[int, str]] = {}
    totals: Counter[Fate] = Counter()

    for layer in layers:
        if isinstance(layer, SkippedLayer):
            skipped.append(SkippedLine(id=layer.id, reason=layer.reason))
            continue
        fates: Counter[Fate] = Counter()
        layer_edits: dict[int, str] = {}
        fits = {area.key: _fits(area.value, layer) for area in theme.areas}
        for row in layer.rows:
            if row.value is None:
                fates["undecodable"] += 1
                continue
            outcome = theme.classify(row.value, row.category)
            if isinstance(outcome, Rule):
                if fits[outcome.area.key]:
                    fates["recolor"] += 1
                    rule_rows[outcome.id] += 1
                    layer_edits[row.index] = outcome.area.value
                else:
                    fates["too_wide"] += 1
                    rule_too_wide[outcome.id] += 1
                continue
            fates[outcome] += 1
            if outcome == "unmapped":
                unmapped_rows[row.value] += 1
                unmapped_layers.setdefault(row.value, {})[layer.id] = None
        if layer_edits:
            edits[layer.id] = MappingProxyType(layer_edits)
        totals.update(fates)
        layer_lines.append(
            LayerLine(
                id=layer.id,
                encoding=layer.encoding,
                width=layer.width,
                width_unit=layer.width_unit,
                counts=_counts(fates),
            )
        )

    report = ThemeReport(
        field=theme.field,
        category_field=theme.category_field,
        category_areas=tuple(
            CategoryAreaLine(
                area=item.area.key,
                area_name=item.area.name,
                value=item.area.value,
                spec=item.area.spec,
                hex=item.area.hex,
                categories=item.values,
            )
            for item in category_classes(theme)
        ),
        rules=tuple(
            RuleLine(
                rule=rule.id,
                old=rule.old,
                old_hex=rule.old_hex,
                scope=rule.scope,
                categories=None if rule.categories is None else tuple(sorted(rule.categories)),
                area=rule.area.key,
                area_name=rule.area.name,
                value=rule.area.value,
                spec=rule.area.spec,
                hex=rule.area.hex,
                rows=rule_rows[rule.id],
                too_wide=rule_too_wide[rule.id],
            )
            for rule in theme.rules
        ),
        unmapped=tuple(
            UnmappedLine(value=value, rows=rows, layers=tuple(unmapped_layers[value]))
            for value, rows in sorted(unmapped_rows.items(), key=lambda item: (-item[1], item[0]))
        ),
        layers=tuple(layer_lines),
        skipped=tuple(skipped),
        totals=_counts(totals),
        symbology=tuple(symbology),
        style_files=tuple(style_files),
    )
    return ThemePlan(report=report, edits=MappingProxyType(edits))
