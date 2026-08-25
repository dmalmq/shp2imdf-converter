"""Auto-fix helpers for validation issues."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from uuid import UUID

from backend.src.geometry import grow_to_cover
from backend.src.schemas import AutofixApplied, AutofixPrompt, ValidationResponse
from backend.src.validator import prune_empty_geometry_features


# Checks that require explicit user confirmation before being applied.
# Only destructive operations (feature deletion) belong here.
PROMPTED_CHECKS = {"duplicate_geometry_warning", "unit_sliver", "unit_outside_level_warning"}


def _round_value(value: Any, decimals: int) -> Any:
    if isinstance(value, float):
        return round(value, decimals)
    if isinstance(value, list):
        return [_round_value(item, decimals) for item in value]
    if isinstance(value, tuple):
        return tuple(_round_value(item, decimals) for item in value)
    if isinstance(value, dict):
        return {key: _round_value(item, decimals) for key, item in value.items()}
    return value


def _looks_like_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except Exception:
        return False


def apply_autofix(
    feature_collection: dict[str, Any],
    validation: ValidationResponse,
    apply_prompted: bool = False,
) -> tuple[dict[str, Any], list[AutofixApplied], list[AutofixPrompt]]:
    updated = copy.deepcopy(feature_collection)
    rows = updated.get("features", [])
    if not isinstance(rows, list):
        return updated, [], []

    by_id = {
        str(item.get("id")): item
        for item in rows
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }

    fixes_applied: list[AutofixApplied] = []
    prompts: list[AutofixPrompt] = []
    issues = [*validation.errors, *validation.warnings]

    # Safe fix: invalid UUIDs and duplicates.
    seen_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        feature_id = row.get("id")
        if not isinstance(feature_id, str):
            continue
        if _looks_like_uuid(feature_id) and feature_id not in seen_ids:
            seen_ids.add(feature_id)
            continue
        new_id = str(uuid4())
        while new_id in seen_ids:
            new_id = str(uuid4())
        seen_ids.add(new_id)
        row["id"] = new_id
        fixes_applied.append(
            AutofixApplied(
                feature_id=new_id,
                check="duplicate_uuids",
                action="regenerate_uuid",
                description="Regenerated duplicate/invalid UUID.",
            )
        )

    # Refresh map after UUID fixes.
    by_id = {
        str(item.get("id")): item
        for item in rows
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }

    # Safe fixes from explicit issues.
    for issue in issues:
        if not issue.feature_id:
            continue
        row = by_id.get(issue.feature_id)
        if not row:
            continue
        geometry = row.get("geometry")

        if issue.check == "invalid_geometry" and isinstance(geometry, dict):
            try:
                repaired = make_valid(shape(geometry))
                # make_valid() can produce GeometryCollection with lines/points;
                # extract only Polygon components to keep the geometry valid for
                # feature types that require Polygon/MultiPolygon.
                if isinstance(repaired, GeometryCollection) and not isinstance(repaired, (Polygon, MultiPolygon)):
                    polygons = [g for g in repaired.geoms if isinstance(g, Polygon) and g.area > 0]
                    if polygons:
                        repaired = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
                row["geometry"] = mapping(repaired)
                fixes_applied.append(
                    AutofixApplied(
                        feature_id=issue.feature_id,
                        check=issue.check,
                        action="make_valid",
                        description="Repaired invalid geometry using make_valid().",
                    )
                )
            except Exception:
                continue

        if issue.check == "excessive_precision" and isinstance(geometry, dict):
            rounded = _round_value(geometry, 7)
            row["geometry"] = rounded
            fixes_applied.append(
                AutofixApplied(
                    feature_id=issue.feature_id,
                    check=issue.check,
                    action="round_coordinates",
                    description="Rounded geometry coordinates to 7 decimals.",
                )
            )

        if issue.check == "polygon_has_interior_rings" and isinstance(geometry, dict):
            try:
                geom = shape(geometry)
                if isinstance(geom, Polygon):
                    stripped = Polygon(geom.exterior)
                elif isinstance(geom, MultiPolygon):
                    stripped = MultiPolygon([Polygon(p.exterior) for p in geom.geoms])
                else:
                    continue
                row["geometry"] = mapping(stripped)
                fixes_applied.append(
                    AutofixApplied(
                        feature_id=issue.feature_id,
                        check=issue.check,
                        action="remove_interior_rings",
                        description="Removed interior rings, keeping only the exterior boundary.",
                    )
                )
            except Exception:
                continue

        if issue.check == "footprint_level_coverage" and issue.related_feature_id and isinstance(geometry, dict):
            level_row = by_id.get(issue.related_feature_id)
            level_geom_raw = level_row.get("geometry") if level_row else None
            if not isinstance(level_geom_raw, dict):
                continue
            try:
                # row["geometry"] may already be expanded by a prior issue for
                # the same footprint, so always read the current state.
                expanded = shape(row["geometry"]).union(shape(level_geom_raw))
                row["geometry"] = mapping(expanded)
                fixes_applied.append(
                    AutofixApplied(
                        feature_id=issue.feature_id,
                        check=issue.check,
                        action="expand_footprint",
                        description="Expanded footprint to cover uncovered level.",
                    )
                )
            except Exception:
                continue

    # Prompted fixes.
    duplicate_pairs: set[tuple[str, str]] = set()
    for issue in issues:
        if issue.check not in PROMPTED_CHECKS:
            continue
        if issue.check == "duplicate_geometry_warning" and issue.feature_id and issue.related_feature_id:
            pair = tuple(sorted([issue.feature_id, issue.related_feature_id]))
            duplicate_pairs.add(pair)

    # A unit that falls outside the level it names is rejected by Apple as an
    # "Invalid level reference" — which reads like a broken id rather than a
    # floor plate that does not reach far enough. Growing the level is the fix,
    # not moving the unit: an outdoor walkway really is where the survey put it.
    # Prompted, because a level's footprint is not a small thing to redraw.
    outside_by_level: dict[str, set[str]] = {}
    for issue in issues:
        if issue.check != "unit_outside_level_warning" or not issue.feature_id:
            continue
        unit = by_id.get(issue.feature_id)
        level_id = (unit or {}).get("properties", {}).get("level_id")
        if isinstance(level_id, str) and level_id in by_id:
            outside_by_level.setdefault(level_id, set()).add(issue.feature_id)

    for level_id, unit_ids in sorted(outside_by_level.items()):
        prompts.append(
            AutofixPrompt(
                feature_id=level_id,
                check="unit_outside_level_warning",
                action="expand_level",
                description=(
                    f"Expand level {level_id[:8]} to cover {len(unit_ids)} feature(s) that fall outside it."
                ),
            )
        )

    for left, right in sorted(duplicate_pairs):
        prompts.append(
            AutofixPrompt(
                feature_id=left,
                related_feature_id=right,
                check="duplicate_geometry_warning",
                action="delete_duplicate",
                description=f"Delete one duplicate geometry ({right[:8]}).",
            )
        )

    if apply_prompted:
        for level_id, unit_ids in sorted(outside_by_level.items()):
            level = by_id.get(level_id)
            if not level or not isinstance(level.get("geometry"), dict):
                continue
            try:
                base = shape(level["geometry"])
                additions = [
                    shape(by_id[unit_id]["geometry"])
                    for unit_id in sorted(unit_ids)
                    if isinstance(by_id.get(unit_id, {}).get("geometry"), dict)
                ]
            except Exception:
                continue
            grown = grow_to_cover(base, additions)
            if grown is None or grown.equals(base):
                continue
            level["geometry"] = mapping(grown)
            fixes_applied.append(
                AutofixApplied(
                    feature_id=level_id,
                    check="unit_outside_level_warning",
                    action="expand_level",
                    description=(
                        f"Expanded level {level_id[:8]} to cover {len(additions)} feature(s) outside it."
                    ),
                )
            )

        to_delete: set[str] = set()
        for left, right in duplicate_pairs:
            # Keep the lexicographically smaller id for deterministic behavior.
            to_delete.add(max(left, right))

        for issue in issues:
            if issue.check == "unit_sliver" and issue.feature_id:
                to_delete.add(issue.feature_id)

        if to_delete:
            kept: list[dict[str, Any]] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                feature_id = row.get("id")
                if isinstance(feature_id, str) and feature_id in to_delete:
                    fixes_applied.append(
                        AutofixApplied(
                            feature_id=feature_id,
                            check="prompted_delete",
                            action="delete_feature",
                            description="Deleted feature after user confirmation.",
                        )
                    )
                    continue
                kept.append(row)
            updated["features"] = kept

    # Safety net: remove any feature left without usable geometry — both
    # pre-existing empties and ones the make_valid repair above collapsed.
    survivors, removed_empty = prune_empty_geometry_features(updated.get("features", rows))
    for feature_id in removed_empty:
        fixes_applied.append(
            AutofixApplied(
                feature_id=feature_id,
                check="empty_geometry",
                action="delete_empty_geometry",
                description="Removed feature with empty/missing geometry.",
            )
        )
    updated["features"] = survivors

    return updated, fixes_applied, prompts
