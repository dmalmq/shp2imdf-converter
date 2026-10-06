"""The station colour theme: which old ``color2`` values become which area names, and what a dataset will see.

Format-neutral on purpose. Nothing here knows about DBF bytes, zips or GDAL: a
layer is an id plus its decoded rows and its target field's width, and the
answer is a report plus per-layer edits. ``recolor.py`` feeds it from
shapefiles; a File Geodatabase reader would build the same ``LayerInput``s.

``load_color_theme`` checks the invariants once, at startup. The one that
matters most: the old vocabulary and the written vocabulary are disjoint, so
everything the tool writes classifies as ``already_new`` next time and a
second run changes nothing.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
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

SkipReason = Literal["field_not_text", "unreadable"]


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
    areas: tuple[Area, ...]
    rules: tuple[Rule, ...]
    new_values: frozenset[str]
    by_old: Mapping[str, OldValue]

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
_TOP_KEYS = {"source", "field", "category_field", "areas", "rules"}
_AREA_KEYS = {"key", "name", "value", "spec", "hex"}
_RULE_KEYS = {"old", "old_hex", "scope", "area", "categories"}
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
    return ColorTheme(
        field=_text(raw["field"], "field"),
        category_field=_text(raw["category_field"], "category_field"),
        areas=tuple(areas.values()),
        rules=tuple(rules),
        new_values=new_values,
        by_old=MappingProxyType(by_old),
    )


@dataclass(frozen=True, slots=True)
class Row:
    index: int
    """Record number in the layer, counting deleted records, so an edit addresses the source row."""
    value: str | None
    """Decoded target field, trailing blanks stripped. None when the bytes do not decode."""
    category: str | None


@dataclass(frozen=True, slots=True)
class Encoding:
    codec: str
    source: str
    """Where the codec came from: "cpg", "ldid", "sniffed" or "ascii" for a shapefile."""


@dataclass(frozen=True, slots=True)
class LayerInput:
    id: str
    """Shown to the operator: the path inside the upload for a shapefile."""
    rows: Sequence[Row]
    width: int
    """The target field's width in bytes of ``encoding.codec``."""
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
    counts: Counts


@dataclass(frozen=True, slots=True)
class SkippedLine:
    id: str
    reason: SkipReason


@dataclass(frozen=True, slots=True)
class ThemeReport:
    field: str
    rules: tuple[RuleLine, ...]
    unmapped: tuple[UnmappedLine, ...]
    """Most rows first."""
    layers: tuple[LayerLine, ...]
    skipped: tuple[SkippedLine, ...]
    totals: Counts


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


def _fits(value: str, codec: str, width: int) -> bool:
    try:
        return len(value.encode(codec)) <= width
    except UnicodeEncodeError:
        return False


def plan(theme: ColorTheme, layers: Sequence[LayerInput | SkippedLayer]) -> ThemePlan:
    """Classify every row of every layer once; the report and the edits come from that one pass.

    A matched rule whose value, encoded with the layer's codec, is wider than
    the field is ``too_wide``: reported, never truncated. Pure, so the inspect
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
        fits = {
            area.key: _fits(area.value, layer.encoding.codec, layer.width) for area in theme.areas
        }
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
            LayerLine(id=layer.id, encoding=layer.encoding, width=layer.width, counts=_counts(fates))
        )

    report = ThemeReport(
        field=theme.field,
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
    )
    return ThemePlan(report=report, edits=MappingProxyType(edits))
