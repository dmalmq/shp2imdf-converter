"""Validation and status annotation for review feature collections."""

from __future__ import annotations

import copy
from collections import Counter, defaultdict
from itertools import combinations
import re
from typing import Any
from uuid import UUID

from shapely.geometry import LineString, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from backend.src.schemas import ValidationIssue, ValidationResponse, ValidationSummary


POLYGON_TYPES = {"venue", "footprint", "level", "unit", "fixture"}
LINE_TYPES = {"opening", "detail"}
NULL_GEOM_TYPES = {"address", "building"}
LEVEL_LINKED_TYPES = {"unit", "opening", "fixture", "detail"}
LABEL_RE = re.compile(r"^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$")


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
    return bool(geom.contains(point) or geom.touches(point))


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
        if fid:
            geoms_by_id[fid] = geom

    level_geoms = {fid: geoms_by_id[fid] for fid in level_ids if fid in geoms_by_id}
    units_by_level: dict[str, list[tuple[str, BaseGeometry]]] = defaultdict(list)

    for row in rows:
        fid = _feature_id(row)
        ftype = _feature_type(row)
        props = _props(row)
        geom = geoms_by_id.get(fid) if fid else None

        for key in ("name", "short_name", "alt_name"):
            if key in props and props.get(key) is not None and not _labels_ok(props.get(key)):
                add_issue("error", "labels_format_valid", f"'{key}' must be LABELS object.", feature_id=fid)

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
            if fid and geom and isinstance(props.get("level_id"), str):
                units_by_level[props["level_id"]].append((fid, geom))
            if geom and geom.area < 1e-10:
                add_issue("warning", "sliver_polygon_warning", "Unit appears to be a sliver polygon.", feature_id=fid)

        if ftype == "opening" and (not isinstance(props.get("category"), str) or not props.get("category")):
            add_issue("error", "opening_missing_category_error", "Opening has no category.", feature_id=fid)
        if ftype == "fixture" and (not isinstance(props.get("category"), str) or not props.get("category")):
            add_issue("error", "fixture_missing_category_error", "Fixture has no category.", feature_id=fid)
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

        if ftype == "building":
            address_id = props.get("address_id")
            if address_id is not None and (not isinstance(address_id, str) or address_id not in address_ids):
                add_issue("error", "building_address_id_valid", "Building address_id does not match an address feature.", feature_id=fid)

    for level_id, pairs in units_by_level.items():
        level_geom = level_geoms.get(level_id)
        for unit_id, unit_geom in pairs:
            if level_geom and not (level_geom.contains(unit_geom.centroid) or level_geom.touches(unit_geom.centroid)):
                add_issue("warning", "unit_outside_level_warning", "Unit centroid is outside assigned level.", feature_id=unit_id)
        for (left_id, left_geom), (right_id, right_geom) in combinations(pairs, 2):
            overlap = left_geom.intersection(right_geom)
            if not overlap.is_empty and overlap.area > 0:
                overlap_geojson = overlap.__geo_interface__
                add_issue("warning", "overlapping_units", f"Overlaps with unit {right_id[:8]}.", feature_id=left_id, related_feature_id=right_id, overlap_geometry=overlap_geojson)
                add_issue("warning", "overlapping_units", f"Overlaps with unit {left_id[:8]}.", feature_id=right_id, related_feature_id=left_id, overlap_geometry=overlap_geojson)

    # Duplicate geometry warning.
    geometry_hashes: dict[tuple[str, str | None, str], str] = {}
    for row in rows:
        fid = _feature_id(row)
        if fid is None or fid not in geoms_by_id:
            continue
        ftype = _feature_type(row)
        if ftype not in {"unit", "opening", "fixture", "detail"}:
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
                if not (venue_geom.contains(centroid) or venue_geom.touches(centroid)):
                    add_issue("warning", "footprint_outside_venue_warning", "Footprint centroid is outside venue.", feature_id=fid)
    if footprints:
        footprints_union = unary_union(footprints)
        for fid, row in by_id.items():
            if _feature_type(row) == "level" and fid in geoms_by_id:
                centroid = geoms_by_id[fid].centroid
                if not (footprints_union.contains(centroid) or footprints_union.touches(centroid)):
                    add_issue("warning", "level_outside_footprint_warning", "Level centroid is outside footprint.", feature_id=fid)

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
                boundaries = unary_union([g.boundary for _, g in units_by_level.get(level_id, [])]).buffer(5e-6) if isinstance(level_id, str) and units_by_level.get(level_id) else None
                if boundaries is not None and not geom.intersects(boundaries):
                    add_issue("warning", "opening_not_touching_boundary", "Opening does not touch any unit boundary.", feature_id=fid)
                meters = geom.length * 111_320
                if meters < 0.3:
                    add_issue("warning", "opening_too_short", "Opening length is unusually short.", feature_id=fid)
                if meters > 10:
                    add_issue("warning", "opening_too_long", "Opening length is unusually long.", feature_id=fid)
            if isinstance(props.get("category"), str) and str(props.get("category")).startswith("pedestrian") and not isinstance(props.get("door"), dict):
                add_issue("warning", "opening_missing_door_warning", "Pedestrian opening is missing door metadata.", feature_id=fid)
        if ftype == "detail":
            level_id = props.get("level_id")
            if isinstance(level_id, str) and level_id in level_geoms and not level_geoms[level_id].intersects(geoms_by_id[fid]):
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

    failed_checks = {issue.check for issue in [*errors, *warnings]}
    passed = sorted({"unique_uuids", "valid_geometry", "venue_exists", "building_exists", "labels_format_valid", "display_points_valid"} - failed_checks)
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
