"""Validation and status annotation for review feature collections."""

from __future__ import annotations

import copy
from collections import Counter, defaultdict
import re
from typing import Any
from uuid import UUID

from shapely import make_valid, prepare
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from backend.src.iso_subdivisions import (
    is_valid_country,
    is_valid_subdivision,
    normalize_country,
    normalize_subdivision,
)
from backend.src.imdf_shapefile_importer import SYNTHESIZED_BUILDING_NAME, SYNTHESIZED_VENUE_NAME
from backend.src.mapper import load_restriction_categories
from backend.src.schemas import ValidationIssue, ValidationResponse, ValidationSummary


POLYGON_TYPES = {"venue", "footprint", "level", "unit", "fixture", "geofence", "kiosk", "section"}
LINE_TYPES = {"opening", "detail"}
POINT_TYPES = {"amenity", "anchor"}
NULL_GEOM_TYPES = {"address", "building", "occupant"}
OPTIONAL_GEOM_TYPES = {"relationship"}
LEVEL_LINKED_TYPES = {"unit", "opening", "fixture", "detail", "kiosk", "section"}
# IMDF restriction is a closed enum. Import repairs near misses
# (`normalize_restriction`); anything left is a value the spec cannot carry, and
# it used to reach unit.geojson and the ODC Space layer with nothing objecting.
RESTRICTION_CATEGORIES = load_restriction_categories()


def feature_requires_geometry(ftype: str) -> bool:
    """True for feature types that must carry geometry (not null/optional types)."""
    return ftype not in NULL_GEOM_TYPES and ftype not in OPTIONAL_GEOM_TYPES


def prune_empty_geometry_features(
    features: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Drop features that require geometry but have empty/missing geometry.

    Returns ``(survivors, removed_ids)``. Used as a safety net after operations
    (auto-fix, overlap clipping) that can leave a geometry-required feature with
    no usable geometry.
    """
    survivors: list[dict[str, Any]] = []
    removed: list[str] = []
    for row in features:
        if not isinstance(row, dict):
            survivors.append(row)
            continue
        ftype = row.get("feature_type") or ""
        payload = row.get("geometry")
        empty = not isinstance(payload, dict)
        if not empty:
            try:
                empty = shape(payload).is_empty
            except Exception:
                empty = True
        if feature_requires_geometry(ftype) and empty:
            removed.append(str(row.get("id")))
            continue
        survivors.append(row)
    return survivors, removed
LABEL_RE = re.compile(r"^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$")
PROVINCE_CODE_RE = re.compile(r"^[A-Z]{2}-[A-Z0-9]{1,3}$")


def _iter_overlapping_pairs(
    pairs: list[tuple[str, BaseGeometry]],
) -> list[tuple[str, BaseGeometry, str, BaseGeometry]]:
    """Find potentially overlapping unit pairs using an STRtree.

    This avoids the O(n^2) full pairwise scan that becomes very slow on
    large datasets while preserving exact overlap checks via intersection.
    """

    if len(pairs) < 2:
        return []

    ids = [fid for fid, _ in pairs]
    geoms = [geom for _, geom in pairs]
    tree = STRtree(geoms)
    overlaps: list[tuple[str, BaseGeometry, str, BaseGeometry]] = []
    seen_pairs: set[tuple[int, int]] = set()

    for left_index, left_geom in enumerate(geoms):
        candidate_indexes = tree.query(left_geom, predicate="intersects")
        for right_index in candidate_indexes.tolist():
            if right_index <= left_index:
                continue
            pair_key = (left_index, right_index)
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            overlaps.append((ids[left_index], left_geom, ids[right_index], geoms[right_index]))

    return overlaps


def _rows(feature_collection: dict[str, Any]) -> list[dict[str, Any]]:
    rows = feature_collection.get("features", [])
    return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []


def _feature_id(row: dict[str, Any]) -> str | None:
    value = row.get("id")
    return value if isinstance(value, str) and value else None


def _feature_type(row: dict[str, Any]) -> str:
    value = row.get("feature_type")
    return value if isinstance(value, str) else ""


def _props(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("properties")
    return value if isinstance(value, dict) else {}


def _geom_payload(row: dict[str, Any]) -> dict[str, Any] | None:
    value = row.get("geometry")
    return value if isinstance(value, dict) else None


def _geom(row: dict[str, Any]) -> BaseGeometry | None:
    payload = _geom_payload(row)
    if payload is None:
        return None
    try:
        return shape(payload)
    except Exception:
        return None


def _flatten_coords(value: Any, acc: list[tuple[float, float]]) -> None:
    if not isinstance(value, list):
        return
    if len(value) >= 2 and isinstance(value[0], (int, float)) and isinstance(value[1], (int, float)):
        acc.append((float(value[0]), float(value[1])))
        return
    for item in value:
        _flatten_coords(item, acc)


def _coords_out_of_bounds(payload: dict[str, Any]) -> bool:
    points: list[tuple[float, float]] = []
    _flatten_coords(payload.get("coordinates"), points)
    return any(lon < -180 or lon > 180 or lat < -90 or lat > 90 for lon, lat in points)


def _max_decimals(payload: dict[str, Any]) -> int:
    points: list[tuple[float, float]] = []
    _flatten_coords(payload.get("coordinates"), points)
    max_dec = 0
    for lon, lat in points:
        for value in (lon, lat):
            text = f"{value:.12f}".rstrip("0").rstrip(".")
            if "." in text:
                max_dec = max(max_dec, len(text.split(".")[1]))
    return max_dec


def _label_text(value: Any) -> str | None:
    if isinstance(value, dict):
        for item in value.values():
            if isinstance(item, str) and item.strip():
                return item.strip()
        return None
    return value.strip() or None if isinstance(value, str) else None


def _floor_token(label: Any) -> str | None:
    """Floor a label names, with the trailing F dropped ("1F" -> "1", "B1" -> "B1")."""
    text = _label_text(label)
    if not text:
        return None
    token = text.strip().upper()
    if len(token) > 1 and token.endswith("F"):
        token = token[:-1]
    return token or None


def _stem_tokens(stem: Any) -> set[str]:
    return {token.upper() for token in re.findall(r"[A-Za-z0-9]+", stem)} if isinstance(stem, str) else set()


def _labels_ok(value: Any) -> bool:
    if not isinstance(value, dict) or not value:
        return False
    has_lang = any(isinstance(k, str) and LABEL_RE.match(k.replace("_", "-")) for k in value.keys())
    has_text = any(isinstance(v, str) and v.strip() for v in value.values())
    return has_lang and has_text


def _point_in_geometry(display_point: Any, geom: BaseGeometry | None) -> bool:
    if geom is None or geom.is_empty:
        return False
    if not isinstance(display_point, dict) or display_point.get("type") != "Point":
        return False
    try:
        point = shape(display_point)
    except Exception:
        return False
    return _safe_contains_or_touches(geom, point)


def _repair_geometry(geom: BaseGeometry | None) -> BaseGeometry | None:
    if geom is None or geom.is_empty or geom.is_valid:
        return geom
    try:
        repaired = make_valid(geom)
        if repaired.is_empty:
            return geom
        return repaired
    except Exception:
        return geom


def _repair_and_prepare(geom: BaseGeometry | None) -> BaseGeometry | None:
    """Repair once and GEOS-prepare for fast repeated `.intersects()` tests against it.

    Use for a geometry that many other geometries get tested against in a loop
    (e.g. a per-level boundary or level polygon) — preparing amortizes far better
    than the unprepared per-call cost once call counts run into the thousands.
    """
    repaired = _repair_geometry(geom)
    if repaired is not None and not repaired.is_empty:
        prepare(repaired)
    return repaired


def _safe_contains_or_touches(container: BaseGeometry | None, target: BaseGeometry | None) -> bool:
    if container is None or target is None or container.is_empty or target.is_empty:
        return False

    left = _repair_geometry(container)
    right = _repair_geometry(target)
    if left is None or right is None or left.is_empty or right.is_empty:
        return False

    try:
        return bool(left.contains(right) or left.touches(right))
    except GEOSException:
        return False


def _safe_intersects(left: BaseGeometry | None, right: BaseGeometry | None) -> bool:
    if left is None or right is None or left.is_empty or right.is_empty:
        return False

    repaired_left = _repair_geometry(left)
    repaired_right = _repair_geometry(right)
    if repaired_left is None or repaired_right is None or repaired_left.is_empty or repaired_right.is_empty:
        return False

    try:
        return bool(repaired_left.intersects(repaired_right))
    except GEOSException:
        return False


def _safe_intersects_repaired_left(repaired_left: BaseGeometry | None, right: BaseGeometry | None) -> bool:
    """Like `_safe_intersects`, but `repaired_left` is assumed already-repaired.

    Used in per-feature loops where `repaired_left` is a shared geometry (e.g. a
    per-level union) that would otherwise get re-validated via `.is_valid` on every
    call — that revalidation dominates runtime on large datasets.
    """
    if repaired_left is None or right is None or repaired_left.is_empty or right.is_empty:
        return False

    repaired_right = _repair_geometry(right)
    if repaired_right is None or repaired_right.is_empty:
        return False

    try:
        return bool(repaired_left.intersects(repaired_right))
    except GEOSException:
        return False


def _safe_intersection(left: BaseGeometry | None, right: BaseGeometry | None) -> BaseGeometry | None:
    if left is None or right is None or left.is_empty or right.is_empty:
        return None

    repaired_left = _repair_geometry(left)
    repaired_right = _repair_geometry(right)
    if repaired_left is None or repaired_right is None or repaired_left.is_empty or repaired_right.is_empty:
        return None

    try:
        return repaired_left.intersection(repaired_right)
    except GEOSException:
        return None


def _looks_like_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except Exception:
        return False


def validate_feature_collection(feature_collection: dict[str, Any]) -> ValidationResponse:
    rows = _rows(feature_collection)
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    def add_issue(
        severity: str,
        check: str,
        message: str,
        feature_id: str | None = None,
        related_feature_id: str | None = None,
        auto_fixable: bool = False,
        fix_description: str | None = None,
        overlap_geometry: dict[str, Any] | None = None,
        snap_candidates: list[str] | None = None,
    ) -> None:
        issue = ValidationIssue(
            feature_id=feature_id,
            related_feature_id=related_feature_id,
            check=check,
            message=message,
            severity=severity,  # type: ignore[arg-type]
            auto_fixable=auto_fixable,
            fix_description=fix_description,
            overlap_geometry=overlap_geometry,
            snap_candidates=snap_candidates or [],
        )
        if severity == "error":
            errors.append(issue)
        else:
            warnings.append(issue)

    by_type = Counter(_feature_type(row) for row in rows)
    ids = [_feature_id(row) for row in rows if _feature_id(row)]
    id_counts = Counter(ids)
    by_id = {fid: row for row in rows if (fid := _feature_id(row))}

    for required in ("venue", "building"):
        if by_type.get(required, 0) == 0:
            add_issue("error", f"missing_{required}", f"Missing required '{required}' feature.")

    for row in rows:
        fid = _feature_id(row)
        if fid is None:
            add_issue("error", "missing_id", "Feature is missing id.")
            continue
        if not _looks_like_uuid(fid):
            add_issue(
                "error",
                "id_not_uuid",
                "Feature id is not a UUID string.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Regenerate UUID for this feature.",
            )
        if id_counts.get(fid, 0) > 1:
            add_issue(
                "error",
                "duplicate_uuids",
                "Duplicate UUID detected.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Regenerate duplicate UUIDs.",
            )

    level_ids = {fid for fid, row in by_id.items() if _feature_type(row) == "level"}
    building_ids = {fid for fid, row in by_id.items() if _feature_type(row) == "building"}
    address_ids = {fid for fid, row in by_id.items() if _feature_type(row) == "address"}
    unit_ids = {fid for fid, row in by_id.items() if _feature_type(row) == "unit"}
    anchor_ids = {fid for fid, row in by_id.items() if _feature_type(row) == "anchor"}
    geoms_by_id: dict[str, BaseGeometry] = {}

    for row in rows:
        fid = _feature_id(row)
        ftype = _feature_type(row)
        payload = _geom_payload(row)
        geom = _geom(row)

        if ftype in NULL_GEOM_TYPES:
            if payload is not None:
                add_issue("error", f"{ftype}_must_be_null", f"{ftype.title()} geometry must be null.", feature_id=fid)
            continue
        if payload is None:
            if ftype in OPTIONAL_GEOM_TYPES:
                continue
            add_issue("error", "empty_geometry", "Geometry is missing.", feature_id=fid)
            continue
        if ftype in POLYGON_TYPES and payload.get("type") not in {"Polygon", "MultiPolygon"}:
            add_issue("error", f"{ftype}_must_be_polygon", f"{ftype.title()} geometry must be Polygon.", feature_id=fid)
        if ftype in LINE_TYPES and payload.get("type") != "LineString":
            add_issue(
                "error",
                f"{ftype}_must_be_linestring",
                f"{ftype.title()} geometry must be LineString.",
                feature_id=fid,
            )
        if ftype in POINT_TYPES and payload.get("type") != "Point":
            add_issue("error", f"{ftype}_must_be_point", f"{ftype.title()} geometry must be Point.", feature_id=fid)
        if geom is None:
            add_issue(
                "error",
                "invalid_geometry",
                "Geometry could not be parsed.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Run make_valid() to repair geometry.",
            )
            continue
        if geom.is_empty:
            add_issue("error", "empty_geometry", "Geometry is empty.", feature_id=fid)
            continue
        if not geom.is_valid:
            add_issue(
                "error",
                "invalid_geometry",
                "Geometry is invalid.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Run make_valid() to repair geometry.",
            )
            geom = _repair_geometry(geom)
        if _coords_out_of_bounds(payload):
            add_issue("error", "coordinates_out_of_bounds", "Coordinates are out of bounds.", feature_id=fid)
        if abs(geom.centroid.x) < 1 and abs(geom.centroid.y) < 1:
            add_issue("error", "null_island_detection", "Feature appears near Null Island.", feature_id=fid)
        if _max_decimals(payload) > 7:
            add_issue(
                "warning",
                "excessive_precision",
                "Geometry precision is above 7 decimal places.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Round coordinates to 7 decimal places.",
            )
        if ftype in POLYGON_TYPES and isinstance(geom, Polygon) and list(geom.interiors):
            add_issue(
                "warning",
                "polygon_has_interior_rings",
                f"Polygon has {len(list(geom.interiors))} interior ring(s) — likely a geometry artifact.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Remove interior rings, keeping only the exterior boundary.",
            )
        elif ftype in POLYGON_TYPES and isinstance(geom, MultiPolygon) and any(list(p.interiors) for p in geom.geoms):
            total = sum(len(list(p.interiors)) for p in geom.geoms)
            add_issue(
                "warning",
                "polygon_has_interior_rings",
                f"MultiPolygon has {total} interior ring(s) — likely a geometry artifact.",
                feature_id=fid,
                auto_fixable=True,
                fix_description="Remove interior rings, keeping only the exterior boundaries.",
            )
        if fid:
            geoms_by_id[fid] = geom

    # Pre-repaired: reused per-feature below (once per level here vs. once per feature there).
    level_geoms = {fid: _repair_and_prepare(geoms_by_id[fid]) for fid in level_ids if fid in geoms_by_id}
    units_by_level: dict[str, list[tuple[str, BaseGeometry]]] = defaultdict(list)
    unit_names: dict[str, str] = {}

    for row in rows:
        fid = _feature_id(row)
        ftype = _feature_type(row)
        props = _props(row)
        geom = geoms_by_id.get(fid) if fid else None

        for key in ("name", "short_name", "alt_name"):
            if key in props and props.get(key) is not None and not _labels_ok(props.get(key)):
                add_issue("error", "labels_format_valid", f"'{key}' must be LABELS object.", feature_id=fid)

        restriction = props.get("restriction")
        if restriction is not None and restriction not in RESTRICTION_CATEGORIES:
            add_issue(
                "error",
                "restriction_valid",
                f"Restriction must be null or one of {', '.join(RESTRICTION_CATEGORIES)}; found '{restriction}'.",
                feature_id=fid,
            )

        if geom is not None and props.get("display_point") is not None and not _point_in_geometry(props.get("display_point"), geom):
            add_issue("error", "display_point_within_geometry", "display_point is outside geometry.", feature_id=fid)

        if ftype in LEVEL_LINKED_TYPES:
            level_id = props.get("level_id")
            if not isinstance(level_id, str) or not level_id:
                add_issue("error", f"{ftype}_missing_level_id_error", f"{ftype.title()} is missing level_id.", feature_id=fid)
            elif level_id not in level_ids:
                add_issue("error", "orphaned_reference_error", "Feature has invalid level_id.", feature_id=fid)

        if ftype == "unit":
            category = props.get("category")
            if not isinstance(category, str) or not category.strip():
                add_issue("error", "unit_missing_category_error", "Unit has no category.", feature_id=fid)
            elif category.strip().lower() == "unspecified":
                add_issue("warning", "unspecified_category", "Unit category is unspecified.", feature_id=fid)
            if fid:
                name_val = props.get("name")
                if isinstance(name_val, dict):
                    first_label = next((v for v in name_val.values() if isinstance(v, str) and v), None)
                    if first_label:
                        unit_names[fid] = first_label
                elif isinstance(name_val, str) and name_val:
                    unit_names[fid] = name_val
            if fid and geom and isinstance(props.get("level_id"), str):
                units_by_level[props["level_id"]].append((fid, geom))
            if geom and geom.area < 1e-10:
                add_issue("warning", "sliver_polygon_warning", "Unit appears to be a sliver polygon.", feature_id=fid)
            if geom:
                area_sq_m = geom.area * (111_320 ** 2)
                if area_sq_m < 0.5:
                    add_issue(
                        "warning",
                        "unit_sliver",
                        f"Unit area is very small ({area_sq_m:.4f} m²) — likely a geometry artifact.",
                        feature_id=fid,
                        auto_fixable=True,
                        fix_description="Delete sliver unit.",
                    )

        if ftype == "opening" and (not isinstance(props.get("category"), str) or not props.get("category")):
            add_issue("error", "opening_missing_category_error", "Opening has no category.", feature_id=fid)
        if ftype == "fixture" and (not isinstance(props.get("category"), str) or not props.get("category")):
            add_issue("error", "fixture_missing_category_error", "Fixture has no category.", feature_id=fid)
        if ftype == "amenity":
            if not isinstance(props.get("category"), str) or not props.get("category"):
                add_issue("error", "amenity_missing_category_error", "Amenity has no category.", feature_id=fid)
            unit_refs = props.get("unit_ids")
            if unit_refs is not None:
                if not isinstance(unit_refs, list):
                    add_issue("error", "amenity_unit_ids_invalid", "Amenity unit_ids must be an array.", feature_id=fid)
                elif any(not isinstance(unit_id, str) or unit_id not in unit_ids for unit_id in unit_refs):
                    add_issue("error", "orphaned_reference_error", "Amenity unit_ids include missing unit.", feature_id=fid)
        if ftype == "anchor":
            unit_ref = props.get("unit_id")
            if unit_ref is not None and (not isinstance(unit_ref, str) or unit_ref not in unit_ids):
                add_issue("error", "orphaned_reference_error", "Anchor unit_id does not match a unit feature.", feature_id=fid)
            address_ref = props.get("address_id")
            if address_ref is not None and (not isinstance(address_ref, str) or address_ref not in address_ids):
                add_issue("error", "orphaned_reference_error", "Anchor address_id does not match an address feature.", feature_id=fid)
        if ftype == "geofence":
            if not isinstance(props.get("category"), str) or not props.get("category"):
                add_issue("error", "geofence_missing_category_error", "Geofence has no category.", feature_id=fid)
            feature_refs = props.get("feature_ids")
            if not isinstance(feature_refs, list):
                add_issue("error", "geofence_feature_ids_invalid", "Geofence feature_ids must be an array.", feature_id=fid)
            elif any(not isinstance(feature_ref, str) or feature_ref not in by_id for feature_ref in feature_refs):
                add_issue("error", "orphaned_reference_error", "Geofence feature_ids include missing feature.", feature_id=fid)
        if ftype == "kiosk":
            anchor_ref = props.get("anchor_id")
            if anchor_ref is not None and (not isinstance(anchor_ref, str) or anchor_ref not in anchor_ids):
                add_issue("error", "orphaned_reference_error", "Kiosk anchor_id does not match an anchor feature.", feature_id=fid)
        if ftype == "occupant":
            if not isinstance(props.get("category"), str) or not props.get("category"):
                add_issue("error", "occupant_missing_category_error", "Occupant has no category.", feature_id=fid)
            anchor_ref = props.get("anchor_id")
            if anchor_ref is not None and (not isinstance(anchor_ref, str) or anchor_ref not in anchor_ids):
                add_issue("error", "orphaned_reference_error", "Occupant anchor_id does not match an anchor feature.", feature_id=fid)
        if ftype == "relationship":
            if not isinstance(props.get("category"), str) or not props.get("category"):
                add_issue("error", "relationship_missing_category_error", "Relationship has no category.", feature_id=fid)
            direction = props.get("direction")
            if direction is not None and direction not in {"directed", "undirected"}:
                add_issue("error", "relationship_direction_invalid", "Relationship direction must be directed/undirected.", feature_id=fid)
            for key in ("origin", "destination"):
                ref = props.get(key)
                if ref is None:
                    continue
                if not isinstance(ref, dict):
                    add_issue("error", "relationship_reference_invalid", f"Relationship {key} must be object.", feature_id=fid)
                    continue
                reference_id = ref.get("id")
                reference_type = ref.get("feature_type")
                if not isinstance(reference_id, str) or not isinstance(reference_type, str):
                    add_issue("error", "relationship_reference_invalid", f"Relationship {key} missing id/feature_type.", feature_id=fid)
                    continue
                target_row = by_id.get(reference_id)
                if target_row is None or _feature_type(target_row) != reference_type:
                    add_issue("error", "orphaned_reference_error", f"Relationship {key} points to missing feature.", feature_id=fid)
        if ftype == "section" and (not isinstance(props.get("category"), str) or not props.get("category")):
            add_issue("error", "section_missing_category_error", "Section has no category.", feature_id=fid)
        if ftype == "detail" and geom and geom.length == 0:
            add_issue("warning", "detail_degenerate_line", "Detail line has zero length.", feature_id=fid)

        if ftype == "level":
            if not isinstance(props.get("ordinal"), int):
                add_issue("error", "level_missing_ordinal_error", "Level is missing ordinal.", feature_id=fid)
            if not _labels_ok(props.get("short_name")):
                add_issue("error", "level_missing_short_name_error", "Level is missing short_name.", feature_id=fid)
            if not isinstance(props.get("outdoor"), bool):
                add_issue("error", "level_missing_outdoor_error", "Level is missing outdoor boolean.", feature_id=fid)
            b_ids = props.get("building_ids")
            if not isinstance(b_ids, list) or not b_ids:
                add_issue("error", "level_missing_building_ids_error", "Level is missing building_ids.", feature_id=fid)
            elif any(not isinstance(bid, str) or bid not in building_ids for bid in b_ids):
                add_issue("error", "orphaned_reference_error", "Level building_ids include missing building.", feature_id=fid)

        if ftype == "footprint":
            if not isinstance(props.get("category"), str) or not props.get("category"):
                add_issue("error", "footprint_missing_category_error", "Footprint is missing category.", feature_id=fid)
            b_ids = props.get("building_ids")
            if not isinstance(b_ids, list) or not b_ids:
                add_issue("error", "footprint_missing_building_ids_error", "Footprint is missing building_ids.", feature_id=fid)
            elif any(not isinstance(bid, str) or bid not in building_ids for bid in b_ids):
                add_issue("error", "orphaned_reference_error", "Footprint building_ids include missing building.", feature_id=fid)

        if ftype == "venue":
            address_id = props.get("address_id")
            if not isinstance(address_id, str) or not address_id:
                add_issue("error", "venue_missing_address_error", "Venue is missing address_id.", feature_id=fid)
            elif address_id not in address_ids:
                add_issue("error", "venue_missing_address_id", "Venue address_id does not match an address feature.", feature_id=fid)
            if props.get("display_point") is None:
                add_issue("error", "venue_missing_display_point_error", "Venue is missing display_point.", feature_id=fid)
            phone = props.get("phone")
            if isinstance(phone, str) and phone.strip() and not phone.strip().startswith("+"):
                add_issue(
                    "warning",
                    "venue_phone_format",
                    "Venue phone should be in international format starting with '+' (e.g. +1-555-123-4567).",
                    feature_id=fid,
                )
            # A dataset with no Site layer gets a synthesized venue, which
            # exports as name "Venue" with category A999 (不明・その他). The
            # IMDF-shapefile profile skips the wizard, so nothing else asks for
            # the real facility details before the bundle ships.
            if _label_text(props.get("name")) in (None, SYNTHESIZED_VENUE_NAME):
                add_issue(
                    "error",
                    "venue_placeholder_metadata",
                    "Venue still carries the placeholder name. Set the facility name before exporting.",
                    feature_id=fid,
                )
            category = props.get("category")
            if not isinstance(category, str) or category.strip().lower() in {"", "unspecified"}:
                add_issue(
                    "error",
                    "venue_placeholder_metadata",
                    "Venue category is unspecified and exports as A999. Pick the facility category.",
                    feature_id=fid,
                )
            hours = props.get("hours")
            if isinstance(hours, str) and hours.strip():
                if not re.match(r"^(Mo|Tu|We|Th|Fr|Sa|Su|PH)([ ,\-;]|$)", hours.strip()):
                    add_issue(
                        "warning",
                        "venue_hours_format",
                        "Venue hours should use OSM opening_hours format (e.g. 'Mo-Fr 09:00-17:00; Sa 10:00-14:00').",
                        feature_id=fid,
                    )

        if ftype == "address":
            country = props.get("country")
            country_code = normalize_country(country) if isinstance(country, str) else None
            if not is_valid_country(country if isinstance(country, str) else None):
                add_issue(
                    "error",
                    "address_invalid_country",
                    "Address country is not a valid ISO 3166-1 alpha-2 code.",
                    feature_id=fid,
                )
            province = props.get("province")
            if isinstance(province, str) and province.strip():
                code = normalize_subdivision(province)
                if not PROVINCE_CODE_RE.match(code or "") or not is_valid_subdivision(code):
                    add_issue(
                        "error",
                        "address_invalid_province",
                        "Address province is not a valid ISO 3166-2 code.",
                        feature_id=fid,
                    )
                elif country_code and not code.startswith(f"{country_code}-"):
                    add_issue(
                        "error",
                        "address_province_country_mismatch",
                        "Address province ISO code does not match the country code.",
                        feature_id=fid,
                    )

        if ftype == "building":
            if _label_text(props.get("name")) in (None, SYNTHESIZED_BUILDING_NAME):
                add_issue(
                    "error",
                    "venue_placeholder_metadata",
                    "Building still carries the placeholder name. Set the building name before exporting.",
                    feature_id=fid,
                )
            address_id = props.get("address_id")
            if address_id is not None and (not isinstance(address_id, str) or address_id not in address_ids):
                add_issue("error", "building_address_id_valid", "Building address_id does not match an address feature.", feature_id=fid)

    # Orphaned address check.
    referenced_address_ids: set[str] = set()
    for row in rows:
        val = _props(row).get("address_id")
        if isinstance(val, str):
            referenced_address_ids.add(val)
    for row in rows:
        if _feature_type(row) == "address" and (fid := _feature_id(row)):
            if fid not in referenced_address_ids:
                add_issue("warning", "orphaned_address", "Address feature is not referenced by any venue or building.", feature_id=fid)

    # Building without footprint check.
    footprinted_building_ids: set[str] = set()
    for row in rows:
        if _feature_type(row) == "footprint":
            for buid in (_props(row).get("building_ids") or []):
                if isinstance(buid, str):
                    footprinted_building_ids.add(buid)
    for row in rows:
        if _feature_type(row) == "building" and (fid := _feature_id(row)):
            if fid not in footprinted_building_ids:
                add_issue("error", "building_missing_footprint", "Building has no footprint referencing it.", feature_id=fid)

    for level_id, pairs in units_by_level.items():
        level_geom = level_geoms.get(level_id)
        for unit_id, unit_geom in pairs:
            if level_geom and not _safe_contains_or_touches(level_geom, unit_geom.centroid):
                add_issue("warning", "unit_outside_level_warning", "Unit centroid is outside assigned level.", feature_id=unit_id)

        for left_id, left_geom, right_id, right_geom in _iter_overlapping_pairs(pairs):
            overlap = _safe_intersection(left_geom, right_geom)
            if overlap is not None and not overlap.is_empty and overlap.area > 0:
                overlap_geojson = overlap.__geo_interface__
                right_label = f"{unit_names[right_id]} ({right_id[:8]})" if right_id in unit_names else right_id[:8]
                left_label = f"{unit_names[left_id]} ({left_id[:8]})" if left_id in unit_names else left_id[:8]
                add_issue("warning", "overlapping_units", f"Overlaps with unit {right_label}.", feature_id=left_id, related_feature_id=right_id, overlap_geometry=overlap_geojson)
                add_issue("warning", "overlapping_units", f"Overlaps with unit {left_label}.", feature_id=right_id, related_feature_id=left_id, overlap_geometry=overlap_geojson)

    # Duplicate geometry warning.
    geometry_hashes: dict[tuple[str, str | None, str], str] = {}
    for row in rows:
        fid = _feature_id(row)
        if fid is None or fid not in geoms_by_id:
            continue
        ftype = _feature_type(row)
        if ftype not in {"unit", "opening", "fixture", "detail", "amenity", "anchor", "geofence", "kiosk", "section"}:
            continue
        level_id = _props(row).get("level_id")
        key = (ftype, level_id if isinstance(level_id, str) else None, geoms_by_id[fid].wkb_hex)
        existing = geometry_hashes.get(key)
        if existing:
            add_issue("warning", "duplicate_geometry_warning", "Feature geometry duplicates another feature.", feature_id=fid, related_feature_id=existing, fix_description="Delete one duplicate feature.")
        else:
            geometry_hashes[key] = fid

    venue_geom = next((geoms_by_id[fid] for fid, row in by_id.items() if _feature_type(row) == "venue" and fid in geoms_by_id), None)
    footprints = [geoms_by_id[fid] for fid, row in by_id.items() if _feature_type(row) == "footprint" and fid in geoms_by_id]
    if venue_geom:
        for fid, row in by_id.items():
            if _feature_type(row) == "footprint" and fid in geoms_by_id:
                centroid = geoms_by_id[fid].centroid
                if not _safe_contains_or_touches(venue_geom, centroid):
                    add_issue("warning", "footprint_outside_venue_warning", "Footprint centroid is outside venue.", feature_id=fid)
    if footprints:
        footprints_union = unary_union(footprints)
        for fid, row in by_id.items():
            if _feature_type(row) == "level" and fid in geoms_by_id:
                centroid = geoms_by_id[fid].centroid
                if not _safe_contains_or_touches(footprints_union, centroid):
                    add_issue("warning", "level_outside_footprint_warning", "Level centroid is outside footprint.", feature_id=fid)

    # Footprint-level ordinal coverage check.
    # aerial should cover ordinal > 0, ground ordinal == 0, subterranean ordinal < 0.
    _ORDINAL_MATCH: dict[str, Any] = {
        "aerial": lambda o: o > 0,
        "ground": lambda o: o == 0,
        "subterranean": lambda o: o < 0,
    }
    fp_by_building_cat: dict[str, dict[str, list[tuple[str, BaseGeometry]]]] = {}
    for row in rows:
        if _feature_type(row) != "footprint":
            continue
        fid = _feature_id(row)
        if not fid or fid not in geoms_by_id:
            continue
        category = _props(row).get("category")
        if category not in _ORDINAL_MATCH:
            continue
        for buid in (_props(row).get("building_ids") or []):
            if isinstance(buid, str):
                fp_by_building_cat.setdefault(buid, {}).setdefault(category, []).append((fid, geoms_by_id[fid]))

    lvl_by_building: dict[str, list[tuple[str, int, BaseGeometry]]] = {}
    for row in rows:
        if _feature_type(row) != "level":
            continue
        fid = _feature_id(row)
        if not fid or fid not in geoms_by_id:
            continue
        ordinal = _props(row).get("ordinal")
        if not isinstance(ordinal, int):
            continue
        for buid in (_props(row).get("building_ids") or []):
            if isinstance(buid, str):
                lvl_by_building.setdefault(buid, []).append((fid, ordinal, geoms_by_id[fid]))

    for buid, cat_fps in fp_by_building_cat.items():
        for category, fp_list in cat_fps.items():
            ordinal_fn = _ORDINAL_MATCH[category]
            fp_union = unary_union([g for _, g in fp_list])
            for level_id, ordinal, level_geom in lvl_by_building.get(buid, []):
                if not ordinal_fn(ordinal):
                    continue
                if not _safe_contains_or_touches(fp_union, level_geom.centroid):
                    # Target the footprint closest to this level for the fix.
                    fp_id = min(fp_list, key=lambda x: x[1].distance(level_geom.centroid))[0]
                    add_issue(
                        "warning",
                        "footprint_level_coverage",
                        f"{category.title()} footprint does not cover level (ordinal {ordinal}).",
                        feature_id=fp_id,
                        related_feature_id=level_id,
                        auto_fixable=True,
                        fix_description=f"Expand {category} footprint to include the level geometry.",
                    )

    level_boundary_cache: dict[str, BaseGeometry | None] = {}

    # Opening/detail warnings.
    for row in rows:
        fid = _feature_id(row)
        if fid is None or fid not in geoms_by_id:
            continue
        ftype = _feature_type(row)
        props = _props(row)
        if ftype == "opening":
            geom = geoms_by_id[fid]
            if isinstance(geom, LineString):
                level_id = props.get("level_id")
                boundaries = None
                if isinstance(level_id, str):
                    if level_id not in level_boundary_cache:
                        level_units = units_by_level.get(level_id, [])
                        if level_units:
                            raw_boundary = unary_union([g.boundary for _, g in level_units]).buffer(5e-6)
                            level_boundary_cache[level_id] = _repair_and_prepare(raw_boundary)
                        else:
                            level_boundary_cache[level_id] = None
                    boundaries = level_boundary_cache[level_id]
                if boundaries is not None and not _safe_intersects_repaired_left(boundaries, geom):
                    level_units_list = units_by_level.get(level_id, [])
                    nearest = sorted(level_units_list, key=lambda x: x[1].boundary.distance(geom))[:3]
                    snap_cands = [uid for uid, _ in nearest]
                    add_issue(
                        "warning",
                        "opening_not_touching_boundary",
                        "Opening does not touch any unit boundary.",
                        feature_id=fid,
                        snap_candidates=snap_cands,
                    )
                level_unit_geoms = [g for _, g in units_by_level.get(level_id, [])] if isinstance(level_id, str) else []
                if level_unit_geoms and any(g.contains(geom.centroid) for g in level_unit_geoms):
                    add_issue(
                        "warning",
                        "opening_through_unit",
                        "Opening centroid is inside a unit interior — opening may pass through a wall rather than lie on it.",
                        feature_id=fid,
                    )
                meters = geom.length * 111_320
                if meters < 0.3:
                    add_issue("warning", "opening_too_short", "Opening length is unusually short.", feature_id=fid)
                if meters > 10:
                    add_issue("warning", "opening_too_long", "Opening length is unusually long.", feature_id=fid)
            if isinstance(props.get("category"), str) and str(props.get("category")).startswith("pedestrian") and not isinstance(props.get("door"), dict):
                add_issue("warning", "opening_missing_door_warning", "Pedestrian opening is missing door metadata.", feature_id=fid)
        if ftype == "detail":
            level_id = props.get("level_id")
            if isinstance(level_id, str) and level_id in level_geoms and not _safe_intersects_repaired_left(level_geoms[level_id], geoms_by_id[fid]):
                add_issue("warning", "detail_outside_level", "Detail geometry is outside assigned level.", feature_id=fid)

    # Cross-level warnings.
    ordinals = sorted({_props(row).get("ordinal") for row in rows if _feature_type(row) == "level" and isinstance(_props(row).get("ordinal"), int)})
    if len(ordinals) >= 2:
        missing: list[int] = []
        for left, right in zip(ordinals, ordinals[1:]):
            if right - left > 1:
                missing.extend(range(left + 1, right))
        if missing:
            add_issue("warning", "level_ordinal_gap", f"Level ordinals have gap(s): {', '.join(str(v) for v in missing)}.")
    for level_id in level_ids:
        if len(units_by_level.get(level_id, [])) == 0:
            add_issue("warning", "level_no_units", "Level has no units assigned.", feature_id=level_id)

    # A source file names the floor it belongs to, so a feature from
    # "..._B2_unit.shp" assigned to a B1 level is a broken level_id in the source
    # rather than a conversion choice. Geometry cannot arbitrate this: the 新宿 B1
    # and B2 level footprints overlap, so most of those rows fall inside both.
    floor_token_by_level = {
        str(row.get("id")): _floor_token(_props(row).get("short_name")) or _floor_token(_props(row).get("name"))
        for row in rows
        if _feature_type(row) == "level" and row.get("id")
    }
    known_floor_tokens = {token for token in floor_token_by_level.values() if token}
    for row in rows:
        ftype = _feature_type(row)
        if ftype not in LEVEL_LINKED_TYPES:
            continue
        props = _props(row)
        level_id = props.get("level_id")
        assigned = floor_token_by_level.get(level_id) if isinstance(level_id, str) else None
        if not assigned:
            continue
        tokens = _stem_tokens(props.get("source_file"))
        if not tokens or assigned in tokens:
            continue
        declared = sorted(tokens & (known_floor_tokens - {assigned}))
        if declared:
            add_issue(
                "warning",
                "level_floor_mismatch",
                f"Source file names floor {declared[0]} but the assigned level is on floor {assigned}.",
                feature_id=str(row.get("id")) if row.get("id") else None,
                related_feature_id=level_id,
            )

    # ODC judges Space names, and a source that carries none produces a bundle of
    # unnamed rooms. One warning per category keeps it actionable without one
    # warning per row.
    nameless_units: Counter = Counter()
    for row in rows:
        if _feature_type(row) != "unit":
            continue
        props = _props(row)
        if _label_text(props.get("name")):
            continue
        category = props.get("category")
        nameless_units[str(category).upper() if isinstance(category, str) and category else "(no category)"] += 1
    for category, count in sorted(nameless_units.items()):
        add_issue(
            "warning",
            "space_missing_name",
            f"{count} space(s) of category {category} have no name.",
        )

    failed_checks = {issue.check for issue in [*errors, *warnings]}
    passed = sorted({"unique_uuids", "valid_geometry", "venue_exists", "building_exists", "venue_placeholder_metadata", "labels_format_valid", "display_points_valid", "restriction_valid", "venue_phone_format", "venue_hours_format", "opening_not_touching_boundary", "polygon_has_interior_rings", "footprint_level_coverage"} - failed_checks)
    summary = ValidationSummary(
        total_features=len(rows),
        by_type=dict(by_type),
        error_count=len(errors),
        warning_count=len(warnings),
        auto_fixable_count=sum(1 for issue in [*errors, *warnings] if issue.auto_fixable),
        checks_passed=len(passed),
        checks_failed=len(failed_checks),
        unspecified_count=sum(1 for issue in warnings if issue.check == "unspecified_category"),
        overlap_count=sum(1 for issue in warnings if issue.check == "overlapping_units"),
        opening_issues_count=sum(1 for issue in warnings if issue.check.startswith("opening_")),
    )
    return ValidationResponse(errors=errors, warnings=warnings, passed=passed, summary=summary)


def annotate_feature_collection_with_validation(feature_collection: dict[str, Any], validation: ValidationResponse) -> dict[str, Any]:
    annotated = copy.deepcopy(feature_collection)
    rows = annotated.get("features", [])
    if not isinstance(rows, list):
        return annotated

    issues_by_id: dict[str, list[ValidationIssue]] = defaultdict(list)
    for issue in [*validation.errors, *validation.warnings]:
        if issue.feature_id:
            issues_by_id[issue.feature_id].append(issue)

    for row in rows:
        if not isinstance(row, dict):
            continue
        fid = _feature_id(row)
        props = _props(row)
        issues = issues_by_id.get(fid, []) if fid else []
        category = props.get("category")
        if any(issue.severity == "error" for issue in issues):
            status = "error"
        elif any(issue.severity == "warning" for issue in issues):
            status = "warning"
        elif isinstance(category, str) and category.strip().lower() == "unspecified":
            status = "unspecified"
        else:
            status = "mapped"
        props["status"] = status
        props["issues"] = [issue.model_dump(exclude_none=True) for issue in issues]
        row["properties"] = props

    return annotated
