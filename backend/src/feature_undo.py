"""What a Check fix leaves behind, and how to undo it.

A fix that reshapes a feature carries its display point along, so moving a
door onto a wall does not leave its label behind as a new error. A fix
reports the features it touched as they were before it ran; restoring them
is a feature edit like any other, so it bumps ``content_rev`` only when it
changes something and the caller revalidates.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

from shapely.affinity import translate
from shapely.geometry import mapping, shape

from backend.src.errors import UndoRejectedError
from backend.src.schemas import FeatureUndo
from backend.src.validator import _point_in_geometry

# Rewritten by every validation, so a fix neither changes nor restores them.
_VALIDATION_ANNOTATIONS = frozenset({"status", "issues"})


def _as_json(value: Any) -> Any:
    """Content as JSON carries it: Shapely's ``mapping`` writes tuples where a
    stored record holds lists, and a browser sends 3.0 back as 3."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
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


def _settled_point(point: dict[str, Any], old_geometry: Any, new_geometry: Any) -> dict[str, Any] | None:
    """Where a display point goes once its shape has changed, or None when it can stay.

    It moves with the shape's centre first, which is exact for a translated
    door; failing that, onto the shape's representative point, which GEOS
    puts on a vertex for a line and inside for a polygon.
    """
    try:
        new = shape(new_geometry)
        old = shape(old_geometry)
        current = shape(point)
    except Exception:
        return None
    if new.is_empty or _point_in_geometry(point, new):
        return None
    shifted = mapping(translate(current, new.centroid.x - old.centroid.x, new.centroid.y - old.centroid.y))
    if _point_in_geometry(shifted, new):
        return shifted
    return mapping(new.representative_point())


def carry_display_points(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``after`` with every reshaped feature's display point back inside its shape."""
    old = _rows_by_id(before)
    carried: list[dict[str, Any]] = []
    for row in after:
        prior = old.get(str(row.get("id"))) if isinstance(row, dict) else None
        properties = row.get("properties") if isinstance(row, dict) else None
        point = properties.get("display_point") if isinstance(properties, dict) else None
        if not prior or prior[0] is row or not isinstance(point, dict) or _as_json(prior[0].get("geometry")) == _as_json(row.get("geometry")):
            carried.append(row)
            continue
        settled = _settled_point(point, prior[0].get("geometry"), row.get("geometry"))
        carried.append(row if settled is None else {**row, "properties": {**properties, "display_point": settled}})
    return carried


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


def _group_fingerprint(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    payload = json.dumps([_content(row) for row in rows], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _seal(undo: FeatureUndo) -> str:
    payload = json.dumps(
        [undo.remove_ids, [[row.get("id"), _content(row)] for row in undo.features], undo.fingerprints],
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def finish_fix(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], FeatureUndo]:
    """Every fix ends here: its features with display points carried along, and
    what undoes it, fingerprinted with what the fix left behind."""
    settled = carry_display_points(before, after)
    undo = undo_between(before, settled)
    result = _rows_by_id(settled)
    touched = [*undo.remove_ids, *(str(row.get("id")) for row in undo.features)]
    undo.fingerprints = {feature_id: _group_fingerprint(result.get(feature_id, [])) for feature_id in touched}
    undo.digest = _seal(undo)
    return settled, undo


def check_restorable(rows: list[dict[str, Any]], undo: FeatureUndo) -> None:
    """Refuses an undo that is not a fix's own, or whose features changed since the fix."""
    touched = set(undo.remove_ids) | {str(row.get("id")) for row in undo.features}
    if not touched or set(undo.fingerprints) != touched or _seal(undo) != undo.digest:
        raise UndoRejectedError("This undo does not belong to a fix.", code="UNDO_INVALID", status_code=400)
    current = _rows_by_id(rows)
    changed = sorted(
        feature_id
        for feature_id, fingerprint in undo.fingerprints.items()
        if _group_fingerprint(current.get(feature_id, [])) != fingerprint
    )
    if changed:
        raise UndoRejectedError(f"{len(changed)} feature(s) changed since the fix, so it can no longer be undone.")


def restore_features(rows: list[dict[str, Any]], undo: FeatureUndo) -> list[dict[str, Any]]:
    """``rows`` with ``undo`` applied. A restored feature takes the place of the
    one it replaces; one the fix deleted goes back at the end."""
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
