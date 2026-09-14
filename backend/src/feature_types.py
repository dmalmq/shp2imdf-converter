"""Canonical IMDF feature-type registry.

One place that answers, per IMDF type: what geometry it takes, which category
catalog governs it, and which properties it carries. The review editor uses this
to let a reviewer re-type a feature that was classified wrongly at import (a
geofence polygon that landed in ``unit.geojson``, say) and to reshape that
feature's properties into the target type's schema instead of leaving the old
type's fields behind for the exporter to emit.

The property lists mirror what ``generator.py`` writes for each type, so a
re-typed feature is indistinguishable from a freshly generated one.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from backend.src.converter import IMDF_TYPE_ORDER, REVIEW_ONLY_PROPERTY_KEYS


CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
CATEGORY_CONFIG_DIR = CONFIG_DIR / "categories"

GeometryKind = Literal["polygon", "line", "point", "null", "any"]

_DEFAULT_OCCUPANT_CATEGORY_PATTERN = r"^[a-z0-9]+(?:[._][a-z0-9]+)*$"

# IMDF properties whose value is an array. A re-type seeds these with ``[]``
# rather than ``null`` so array-shape checks in the validator (geofence
# ``feature_ids``, amenity ``unit_ids``) stay satisfied on the new type.
LIST_PROPERTY_KEYS = frozenset(
    {
        "accessibility",
        "access_control",
        "building_ids",
        "feature_ids",
        "level_ids",
        "parents",
        "unit_ids",
    }
)

_GEOMETRY_KIND_BY_TYPE: dict[str, GeometryKind] = {
    "Polygon": "polygon",
    "MultiPolygon": "polygon",
    "LineString": "line",
    "MultiLineString": "line",
    "Point": "point",
    "MultiPoint": "point",
}


@lru_cache(maxsize=None)
def _load_catalog(path: Path) -> tuple[tuple[str, ...], str | None, str | None]:
    """Read a category catalog: ``(categories, default_category, pattern)``."""
    if not path.exists():
        return (), None, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return (), None, None
    raw_categories = payload.get("categories")
    categories: tuple[str, ...] = ()
    if isinstance(raw_categories, list):
        categories = tuple(
            sorted({str(item).strip().lower() for item in raw_categories if str(item).strip()})
        )
    default = payload.get("default_category")
    default_category = str(default).strip().lower() or None if isinstance(default, str) else None
    pattern = payload.get("validation_pattern")
    validation_pattern = pattern.strip() or None if isinstance(pattern, str) else None
    return categories, default_category, validation_pattern


def load_category_set(filename: str) -> set[str]:
    """Categories declared by a catalog file under ``config/categories``."""
    return set(_load_catalog(CATEGORY_CONFIG_DIR / filename)[0])


def load_occupant_category_pattern() -> re.Pattern[str]:
    """Occupant categories are an open vocabulary constrained by a regex."""
    _, _, pattern = _load_catalog(CATEGORY_CONFIG_DIR / "occupant_categories.json")
    return re.compile(pattern or _DEFAULT_OCCUPANT_CATEGORY_PATTERN)


@dataclass(frozen=True)
class FeatureTypeSpec:
    """Geometry family, category catalog and property schema of one IMDF type."""

    feature_type: str
    geometry: GeometryKind
    catalog: Path | None
    fallback_category: str | None
    properties: tuple[str, ...]

    @property
    def has_category(self) -> bool:
        return "category" in self.properties


def _catalog(name: str) -> Path:
    return CATEGORY_CONFIG_DIR / f"{name}_categories.json"


# Units are governed by ``config/unit_categories.json`` -- the same catalog the
# wizard offers and the generator validates against, which is a superset of
# ``config/categories/unit_categories.json`` and carries a default_category.
_UNIT_CATALOG = CONFIG_DIR / "unit_categories.json"


FEATURE_TYPE_SPECS: dict[str, FeatureTypeSpec] = {
    spec.feature_type: spec
    for spec in (
        FeatureTypeSpec(
            "address",
            "null",
            None,
            None,
            (
                "address",
                "unit",
                "locality",
                "province",
                "country",
                "postal_code",
                "postal_code_ext",
                "postal_code_vanity",
            ),
        ),
        FeatureTypeSpec(
            "venue",
            "polygon",
            _catalog("venue"),
            "unspecified",
            (
                "category",
                "restriction",
                "name",
                "alt_name",
                "hours",
                "phone",
                "website",
                "display_point",
                "address_id",
            ),
        ),
        FeatureTypeSpec(
            "building",
            "null",
            _catalog("building"),
            "unspecified",
            ("category", "restriction", "name", "alt_name", "display_point", "address_id"),
        ),
        FeatureTypeSpec(
            "footprint",
            "polygon",
            _catalog("footprint"),
            "ground",
            ("category", "name", "building_ids"),
        ),
        FeatureTypeSpec(
            "level",
            "polygon",
            _catalog("level"),
            "unspecified",
            (
                "category",
                "restriction",
                "outdoor",
                "ordinal",
                "name",
                "short_name",
                "display_point",
                "address_id",
                "building_ids",
            ),
        ),
        FeatureTypeSpec(
            "unit",
            "polygon",
            _UNIT_CATALOG,
            "unspecified",
            (
                "category",
                "restriction",
                "accessibility",
                "name",
                "alt_name",
                "display_point",
                "level_id",
            ),
        ),
        FeatureTypeSpec(
            "opening",
            "line",
            _catalog("opening"),
            "pedestrian",
            (
                "category",
                "accessibility",
                "access_control",
                "door",
                "name",
                "alt_name",
                "display_point",
                "level_id",
            ),
        ),
        FeatureTypeSpec(
            "fixture",
            "polygon",
            _catalog("fixture"),
            "unspecified",
            ("category", "name", "alt_name", "anchor_id", "display_point", "level_id"),
        ),
        FeatureTypeSpec(
            "section",
            "polygon",
            _catalog("section"),
            "walkway",
            (
                "category",
                "restriction",
                "accessibility",
                "name",
                "alt_name",
                "display_point",
                "level_id",
                "parents",
            ),
        ),
        FeatureTypeSpec("anchor", "point", None, None, ("address_id", "unit_id")),
        FeatureTypeSpec(
            "kiosk",
            "polygon",
            None,
            None,
            (
                "name",
                "alt_name",
                "hours",
                "phone",
                "website",
                "anchor_id",
                "display_point",
                "level_id",
            ),
        ),
        FeatureTypeSpec(
            "amenity",
            "point",
            _catalog("amenity"),
            "unspecified",
            (
                "category",
                "accessibility",
                "name",
                "alt_name",
                "hours",
                "phone",
                "website",
                "address_id",
                "unit_ids",
                "correlation_id",
            ),
        ),
        FeatureTypeSpec(
            "occupant",
            "null",
            _catalog("occupant"),
            "occupant",
            (
                "category",
                "name",
                "hours",
                "phone",
                "website",
                "validity",
                "anchor_id",
                "correlation_id",
            ),
        ),
        FeatureTypeSpec(
            "geofence",
            "polygon",
            _catalog("geofence"),
            "geofence",
            (
                "category",
                "restriction",
                "name",
                "alt_name",
                "display_point",
                "building_ids",
                "level_ids",
                "parents",
                "feature_ids",
                "correlation_id",
            ),
        ),
        FeatureTypeSpec(
            "relationship",
            "any",
            _catalog("relationship"),
            "traversal",
            ("category", "direction", "origin", "destination", "hours", "name", "alt_name"),
        ),
        FeatureTypeSpec("detail", "line", None, None, ("level_id",)),
        FeatureTypeSpec(
            "facility",
            "polygon",
            None,
            "unspecified",
            ("category", "name", "alt_name", "display_point", "level_id"),
        ),
    )
}


def spec_for(feature_type: Any) -> FeatureTypeSpec | None:
    if not isinstance(feature_type, str):
        return None
    return FEATURE_TYPE_SPECS.get(feature_type.strip().lower())


def categories_for(feature_type: str) -> tuple[str, ...] | None:
    """Closed category enum for a type, or ``None`` when the vocabulary is open."""
    spec = FEATURE_TYPE_SPECS[feature_type]
    if spec.catalog is None:
        return None
    categories = _load_catalog(spec.catalog)[0]
    return categories or None


@lru_cache(maxsize=None)
def _category_lookup(feature_type: str) -> frozenset[str]:
    return frozenset(categories_for(feature_type) or ())


def category_pattern(feature_type: str) -> re.Pattern[str] | None:
    """Regex an open-vocabulary category must match, if the catalog declares one."""
    spec = FEATURE_TYPE_SPECS[feature_type]
    if spec.catalog is None:
        return None
    pattern = _load_catalog(spec.catalog)[2]
    return re.compile(pattern) if pattern else None


def resolve_category(value: Any, feature_type: str) -> str | None:
    """Coerce a category to one the target type accepts, else its fallback."""
    spec = FEATURE_TYPE_SPECS[feature_type]
    if not spec.has_category:
        return None
    text = value.strip().lower() if isinstance(value, str) else ""
    options = _category_lookup(feature_type)
    if options:
        return text if text in options else spec.fallback_category
    pattern = category_pattern(feature_type)
    if text and (pattern is None or pattern.fullmatch(text)):
        return text
    return spec.fallback_category


def geometry_kind(geometry: Any) -> GeometryKind:
    if geometry is None:
        return "null"
    if not isinstance(geometry, dict):
        return "any"
    if geometry.get("type") == "GeometryCollection":
        return "any"
    return _GEOMETRY_KIND_BY_TYPE.get(geometry.get("type"), "any")


def geometry_is_compatible(geometry: Any, feature_type: str) -> bool:
    """Whether ``geometry`` can be carried unchanged onto ``feature_type``."""
    spec = FEATURE_TYPE_SPECS[feature_type]
    if spec.geometry == "any":
        return True
    return geometry_kind(geometry) == spec.geometry


def compatible_feature_types(geometry: Any) -> list[str]:
    """Types a feature with this geometry can become, in IMDF export order."""
    return [
        feature_type
        for feature_type in IMDF_TYPE_ORDER
        if geometry_is_compatible(geometry, feature_type)
    ]


def _bridge_level_links(properties: dict[str, Any]) -> dict[str, Any]:
    """Translate between the ``level_id`` and ``level_ids`` spellings of floor
    membership so a re-type does not silently drop the feature's floor."""
    level_id = properties.get("level_id")
    level_ids = properties.get("level_ids")
    has_single = isinstance(level_id, str) and level_id
    has_many = isinstance(level_ids, list) and level_ids

    bridged: dict[str, Any] = {}
    if has_many and not has_single:
        first = next((item for item in level_ids if isinstance(item, str) and item), None)
        if first:
            bridged["level_id"] = first
    if has_single and not has_many:
        bridged["level_ids"] = [level_id]
    return bridged


def conform_properties(properties: Any, target_type: str) -> dict[str, Any]:
    """Reshape a feature's properties into ``target_type``'s IMDF schema.

    Keys the target type does not declare are dropped -- otherwise the exporter
    would write a unit's ``accessibility`` into ``geofence.geojson``. Review
    bookkeeping (status, issues, provenance) is preserved so the feature keeps
    its place in the review list, and the category is coerced into the target
    catalog because catalogs do not overlap (``road`` is a unit category, not a
    geofence one).
    """
    source = properties if isinstance(properties, dict) else {}
    spec = FEATURE_TYPE_SPECS[target_type]
    carried = {**source, **_bridge_level_links(source)}

    conformed: dict[str, Any] = {}
    for key in spec.properties:
        if key == "category":
            conformed[key] = resolve_category(source.get("category"), target_type)
        elif key in carried:
            conformed[key] = carried[key]
        else:
            conformed[key] = [] if key in LIST_PROPERTY_KEYS else None

    for key in REVIEW_ONLY_PROPERTY_KEYS:
        if key in source:
            conformed[key] = source[key]
    return conformed


def feature_type_catalog() -> list[dict[str, Any]]:
    """Registry rendered for the review editor's type and category pickers."""
    return [
        {
            "feature_type": feature_type,
            "geometry": FEATURE_TYPE_SPECS[feature_type].geometry,
            "has_category": FEATURE_TYPE_SPECS[feature_type].has_category,
            "categories": list(categories_for(feature_type) or []) or None,
            "default_category": FEATURE_TYPE_SPECS[feature_type].fallback_category,
        }
        for feature_type in IMDF_TYPE_ORDER
    ]
