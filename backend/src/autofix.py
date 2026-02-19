"""Auto-fix helpers for validation issues."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from shapely import make_valid
from shapely.geometry import mapping, shape
from uuid import UUID

from backend.src.schemas import AutofixApplied, AutofixPrompt, ValidationResponse


PROMPTED_CHECKS = {"duplicate_geometry_warning", "empty_geometry"}


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

    # Prompted fixes.
    duplicate_pairs: set[tuple[str, str]] = set()
    empty_ids: set[str] = set()
    for issue in issues:
        if issue.check not in PROMPTED_CHECKS:
            continue
        if issue.check == "duplicate_geometry_warning" and issue.feature_id and issue.related_feature_id:
            pair = tuple(sorted([issue.feature_id, issue.related_feature_id]))
            duplicate_pairs.add(pair)
        if issue.check == "empty_geometry" and issue.feature_id:
            empty_ids.add(issue.feature_id)

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
    for feature_id in sorted(empty_ids):
        prompts.append(
            AutofixPrompt(
                feature_id=feature_id,
                check="empty_geometry",
                action="delete_empty",
                description="Delete feature with empty geometry.",
            )
        )

    if apply_prompted:
        to_delete: set[str] = set()
        for left, right in duplicate_pairs:
            # Keep the lexicographically smaller id for deterministic behavior.
            to_delete.add(max(left, right))
        to_delete.update(empty_ids)
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

    return updated, fixes_applied, prompts
