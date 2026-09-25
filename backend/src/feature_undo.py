"""Undo for the fixes Check offers.

A fix reports the features it touched as they were before it ran; restoring
them is a feature edit like any other, so it bumps ``content_rev`` only when
it changes something and the caller revalidates.
"""

from __future__ import annotations

import copy
from typing import Any

from backend.src.schemas import FeatureUndo

# Rewritten by every validation, so a fix neither changes nor restores them.
_VALIDATION_ANNOTATIONS = frozenset({"status", "issues"})


def _as_json(value: Any) -> Any:
    """Shapely's ``mapping`` writes tuples where a stored record holds lists."""
    if isinstance(value, (list, tuple)):
        return [_as_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _as_json(item) for key, item in value.items()}
    return value


def _content(row: dict[str, Any]) -> Any:
    properties = row.get("properties")
    if isinstance(properties, dict):
        properties = {key: value for key, value in properties.items() if key not in _VALIDATION_ANNOTATIONS}
    return _as_json([row.get("feature_type"), row.get("geometry"), properties])


def _same(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> bool:
    if len(left) != len(right):
        return False
    return all(a is b or _content(a) == _content(b) for a, b in zip(left, right))


def _rows_by_id(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if isinstance(row, dict):
            grouped.setdefault(str(row.get("id")), []).append(row)
    return grouped


def undo_between(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> FeatureUndo:
    """What turns ``after`` back into ``before``. Ids are compared as groups,
    since a collection can hold duplicates until auto-fix renumbers them."""
    old, new = _rows_by_id(before), _rows_by_id(after)
    touched = [
        feature_id
        for feature_id in dict.fromkeys([*old, *new])
        if not _same(old.get(feature_id, []), new.get(feature_id, []))
    ]
    return FeatureUndo(
        remove_ids=[feature_id for feature_id in touched if feature_id in new],
        features=[copy.deepcopy(row) for feature_id in touched for row in old.get(feature_id, [])],
    )


def restore_features(rows: list[dict[str, Any]], undo: FeatureUndo) -> list[dict[str, Any]]:
    """``rows`` with ``undo`` applied. A restored feature takes the place of the
    one it replaces; one the fix deleted goes back at the end."""
    if any(not isinstance(row.get("id"), str) for row in undo.features):
        raise ValueError("Every restored feature needs a string id")
    pending = _rows_by_id(undo.features)
    dropped = set(undo.remove_ids) | set(pending)
    restored: list[dict[str, Any]] = []
    for row in rows:
        feature_id = str(row.get("id")) if isinstance(row, dict) else None
        if feature_id in dropped:
            restored.extend(pending.pop(feature_id, []))
            continue
        restored.append(row)
    for group in pending.values():
        restored.extend(group)
    return restored


def changes_anything(undo: FeatureUndo) -> bool:
    return bool(undo.remove_ids or undo.features)
