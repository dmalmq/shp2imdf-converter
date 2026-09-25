"""Feature retrieval endpoints."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Request
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

from backend.routers.common import get_session_or_raise, session_manager
from backend.src.errors import NotFoundError, RevisionStaleError
from backend.src.detector import (
    detect_files,
    infer_learning_suggestion,
    load_keyword_map,
    merge_learned_keywords,
    sync_feature_types,
)
from backend.src.feature_types import (
    conform_properties,
    geometry_is_compatible,
    geometry_kind,
    spec_for,
)
from backend.src.feature_undo import (
    changes_anything,
    check_restorable,
    finish_fix,
    restore_features,
    same_content,
    undo_between,
)
from backend.src.importer import rebuild_normalized_feature_collection
from backend.src.projects import current_validation, mark_changed, mark_validated
from backend.src.schemas import (
    BulkPatchFeaturesRequest,
    BulkPatchFeaturesResponse,
    BulkPatchWithUndoResponse,
    DetectResponse,
    FeatureResponse,
    FeatureCollectionResponse,
    ImportedFile,
    PatchFeatureRequest,
    ValidationResponse,
    ResolveUnitOverlapRequest,
    ResolveUnitOverlapsResponse,
    UpdateFileRequest,
    UpdateFileResponse,
)
from backend.src.validator import (
    annotate_feature_collection_with_validation,
    prune_empty_geometry_features,
    validate_feature_collection,
)


router = APIRouter(prefix="/api/session/{session_id}", tags=["features"])


def _merged_keyword_map(request: Request, session_learned_keywords: dict[str, str]) -> dict[str, set[str]]:
    base = load_keyword_map(request.app.state.filename_keywords_path)
    return merge_learned_keywords(base_keywords=base, learned_keywords=session_learned_keywords)


def _find_feature_index(features: list[dict[str, Any]], feature_id: str) -> int | None:
    for index, item in enumerate(features):
        if str(item.get("id")) == feature_id:
            return index
    return None


def _merge_properties(current: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(current)
    for key, value in updates.items():
        merged[key] = value
    return merged


def _retype_feature(feature: dict[str, Any], requested_type: str) -> bool:
    """Move a feature onto another IMDF type, reshaping its properties.

    Import classification is per source file, so a whole shapefile lands on one
    type and reviewers need a way to correct individual features afterwards.
    Returns whether the type actually changed.
    """
    spec = spec_for(requested_type)
    if spec is None:
        raise ValueError(f"Unknown IMDF feature type: {requested_type}")
    if spec.feature_type == feature.get("feature_type"):
        return False

    geometry = feature.get("geometry")
    if not geometry_is_compatible(geometry, spec.feature_type):
        raise ValueError(
            f"A feature with {geometry_kind(geometry)} geometry cannot become "
            f"{spec.feature_type}, which requires {spec.geometry} geometry."
        )

    feature["properties"] = conform_properties(feature.get("properties"), spec.feature_type)
    feature["feature_type"] = spec.feature_type
    return True


def _feature_by_id(features: list[dict[str, Any]], feature_id: str) -> tuple[int, dict[str, Any]] | None:
    for index, item in enumerate(features):
        if str(item.get("id")) == feature_id:
            return index, item
    return None


def _label_present(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, dict):
        return any(isinstance(item, str) and item.strip() for item in value.values())
    return False


def _unit_keep_priority(feature: dict[str, Any], area: float) -> tuple[int, int, float]:
    props = feature.get("properties")
    if not isinstance(props, dict):
        props = {}
    category = props.get("category")
    has_specific_category = isinstance(category, str) and bool(category.strip()) and category.strip().lower() != "unspecified"
    has_name = _label_present(props.get("name"))
    return (1 if has_specific_category else 0, 1 if has_name else 0, area)


def _clip_unit_overlap(
    features: list[dict[str, Any]],
    keep_feature_id: str,
    clip_feature_id: str,
) -> tuple[int, int]:
    if keep_feature_id == clip_feature_id:
        raise ValueError("keep_feature_id and clip_feature_id must differ")

    keep_pair = _feature_by_id(features, keep_feature_id)
    clip_pair = _feature_by_id(features, clip_feature_id)
    if keep_pair is None or clip_pair is None:
        raise ValueError("One or both overlap features were not found")

    _, keep_feature = keep_pair
    clip_index, clip_feature = clip_pair

    if keep_feature.get("feature_type") != "unit" or clip_feature.get("feature_type") != "unit":
        raise ValueError("Overlap resolution only supports unit features")

    keep_props = keep_feature.get("properties")
    clip_props = clip_feature.get("properties")
    keep_level = keep_props.get("level_id") if isinstance(keep_props, dict) else None
    clip_level = clip_props.get("level_id") if isinstance(clip_props, dict) else None
    if isinstance(keep_level, str) and isinstance(clip_level, str) and keep_level != clip_level:
        raise ValueError("Units must belong to the same level for overlap resolution")

    keep_geometry = keep_feature.get("geometry")
    clip_geometry = clip_feature.get("geometry")
    if not isinstance(keep_geometry, dict) or not isinstance(clip_geometry, dict):
        raise ValueError("Both units must have valid geometry payloads")

    try:
        keep_geom = shape(keep_geometry)
        clip_geom = shape(clip_geometry)
    except Exception as exc:
        raise ValueError("Failed to parse unit geometry for overlap resolution") from exc

    overlap = keep_geom.intersection(clip_geom)
    if overlap.is_empty or overlap.area <= 0:
        return 0, 0

    clipped = clip_geom.difference(keep_geom)
    if clipped.is_empty or clipped.area <= 0:
        features.pop(clip_index)
        return 0, 1

    clipped = make_valid(clipped)
    if clipped.is_empty or clipped.area <= 0:
        features.pop(clip_index)
        return 0, 1

    # Normalize to Polygon/MultiPolygon — difference() or make_valid() can
    # produce GeometryCollection containing lines/points alongside polygons.
    if isinstance(clipped, GeometryCollection) and not isinstance(clipped, (Polygon, MultiPolygon)):
        polygons = [g for g in clipped.geoms if isinstance(g, Polygon) and g.area > 0]
        if not polygons:
            features.pop(clip_index)
            return 0, 1
        clipped = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)

    updated_clip = copy.deepcopy(clip_feature)
    updated_clip["geometry"] = mapping(clipped)
    features[clip_index] = updated_clip
    return 1, 0


def _choose_safe_overlap_resolution(
    left_feature: dict[str, Any],
    right_feature: dict[str, Any],
) -> tuple[str, str] | None:
    left_id = left_feature.get("id")
    right_id = right_feature.get("id")
    if not isinstance(left_id, str) or not isinstance(right_id, str):
        return None
    if left_feature.get("feature_type") != "unit" or right_feature.get("feature_type") != "unit":
        return None

    left_geometry = left_feature.get("geometry")
    right_geometry = right_feature.get("geometry")
    if not isinstance(left_geometry, dict) or not isinstance(right_geometry, dict):
        return None

    left_props = left_feature.get("properties")
    right_props = right_feature.get("properties")
    left_level = left_props.get("level_id") if isinstance(left_props, dict) else None
    right_level = right_props.get("level_id") if isinstance(right_props, dict) else None
    if isinstance(left_level, str) and isinstance(right_level, str) and left_level != right_level:
        return None

    try:
        left_geom = shape(left_geometry)
        right_geom = shape(right_geometry)
    except Exception:
        return None
    if left_geom.is_empty or right_geom.is_empty or left_geom.area <= 0 or right_geom.area <= 0:
        return None

    overlap = left_geom.intersection(right_geom)
    if overlap.is_empty or overlap.area <= 0:
        return None

    # IMDF models standalone columns as units standing inside other units, so
    # a column always wins: keep the column and clip the surrounding unit.
    # This must precede the containment heuristic, which would otherwise
    # treat the contained column as the unit to clip away.
    left_category = left_props.get("category") if isinstance(left_props, dict) else None
    right_category = right_props.get("category") if isinstance(right_props, dict) else None
    left_is_column = isinstance(left_category, str) and left_category.strip().lower() == "column"
    right_is_column = isinstance(right_category, str) and right_category.strip().lower() == "column"
    if left_is_column != right_is_column:
        return (left_id, right_id) if left_is_column else (right_id, left_id)

    left_ratio = overlap.area / left_geom.area
    right_ratio = overlap.area / right_geom.area
    near_match_threshold = 0.98
    containment_ratio = 0.98
    tiny_overlap_ratio = 0.01

    # Near-duplicate units: keep the unit with stronger metadata and clip/delete the other.
    if left_ratio >= near_match_threshold and right_ratio >= near_match_threshold:
        left_rank = _unit_keep_priority(left_feature, left_geom.area)
        right_rank = _unit_keep_priority(right_feature, right_geom.area)
        if left_rank > right_rank:
            return left_id, right_id
        if right_rank > left_rank:
            return right_id, left_id
        return (left_id, right_id) if left_id < right_id else (right_id, left_id)

    # Clear containment: preserve the larger unit and clip/delete the mostly-contained unit.
    if left_ratio >= containment_ratio and right_ratio < 0.5:
        return right_id, left_id
    if right_ratio >= containment_ratio and left_ratio < 0.5:
        return left_id, right_id

    # Tiny sliver overlap: preserve larger area unit and clip smaller.
    if left_ratio <= tiny_overlap_ratio and right_ratio <= tiny_overlap_ratio:
        if left_geom.area >= right_geom.area:
            return left_id, right_id
        return right_id, left_id

    return None


def _revalidate_session(session: Any) -> ValidationResponse:
    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    mark_validated(session, validation)
    return validation


def _refresh_source_views(session: Any) -> None:
    source_collection = session.source_feature_collection or session.feature_collection
    session.source_feature_collection = sync_feature_types(source_collection, session.files)
    normalized_collection, session.files, _ = rebuild_normalized_feature_collection(
        session.source_feature_collection,
        session.files,
    )
    if session.wizard.generation_status != "generated":
        session.feature_collection = normalized_collection


@router.get("/features", response_model=FeatureCollectionResponse)
def get_features(session_id: str, request: Request) -> FeatureCollectionResponse:
    session = get_session_or_raise(session_id, request)
    return FeatureCollectionResponse.model_validate({**session.feature_collection, "content_rev": session.content_rev})


def _require_revision(session: Any, base_rev: int | None) -> None:
    if base_rev is not None and base_rev != session.content_rev:
        raise RevisionStaleError()


@router.get("/files")
def get_files(session_id: str, request: Request) -> dict:
    session = get_session_or_raise(session_id, request)
    return {
        "session_id": session_id,
        "import_profile": session.import_profile,
        "files": [item.model_dump() for item in session.files],
    }


@router.post("/detect", response_model=DetectResponse)
def detect_all(session_id: str, request: Request) -> DetectResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    keyword_map = _merged_keyword_map(request, session.learned_keywords)
    before = session.files
    session.files = detect_files(session.files, keyword_map, preserve_manual_levels=True)
    if session.files != before:
        mark_changed(session, "files_detected")
    _refresh_source_views(session)
    manager.save_session(session)

    return DetectResponse(session_id=session_id, files=session.files)


@router.patch("/files/{stem}", response_model=UpdateFileResponse)
def patch_file(stem: str, session_id: str, payload: UpdateFileRequest, request: Request) -> UpdateFileResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    file_index = next((index for index, item in enumerate(session.files) if item.stem == stem), None)
    if file_index is None:
        raise NotFoundError("File stem not found")

    current: ImportedFile = session.files[file_index]
    files_before = [item.model_dump_json() for item in session.files]
    keywords_before = dict(session.learned_keywords)
    updated = current.model_copy(deep=True)
    changed_fields = payload.model_fields_set

    if "detected_type" in changed_fields:
        updated.detected_type = payload.detected_type
        if payload.detected_type:
            updated.confidence = "green"
    if "detected_level" in changed_fields:
        updated.detected_level = payload.detected_level
    if "level_name" in changed_fields:
        updated.level_name = payload.level_name
    if "short_name" in changed_fields:
        updated.short_name = payload.short_name
    if "outdoor" in changed_fields and payload.outdoor is not None:
        updated.outdoor = payload.outdoor
    if "level_category" in changed_fields:
        updated.level_category = payload.level_category or "unspecified"

    keyword = (payload.learning_keyword or "").strip().lower()
    feature_type = (payload.detected_type or updated.detected_type or "").strip().lower()
    # Rejected before the cached record is touched, so a later save cannot persist half a request.
    if payload.apply_learning and not keyword:
        raise ValueError("learning_keyword is required when apply_learning=true")
    if payload.apply_learning and not feature_type:
        raise ValueError("detected_type is required when apply_learning=true")

    session.files[file_index] = updated
    learning_suggestion = None

    if payload.apply_learning:
        learned_key = keyword if keyword.startswith("suffix:") else f"suffix:{keyword}"
        session.learned_keywords[learned_key] = feature_type
        merged = _merged_keyword_map(request, session.learned_keywords)
        session.files = detect_files(session.files, merged, preserve_manual_levels=True)
    else:
        if payload.detected_type and payload.detected_type != current.detected_type:
            merged = _merged_keyword_map(request, session.learned_keywords)
            learning_suggestion = infer_learning_suggestion(
                files=session.files,
                changed_stem=stem,
                new_type=payload.detected_type,
                keywords=merged,
            )

    _refresh_source_views(session)
    if [item.model_dump_json() for item in session.files] != files_before or session.learned_keywords != keywords_before:
        mark_changed(session, "file_changed", stem=stem)
    manager.save_session(session)

    final_file = next((item for item in session.files if item.stem == stem), updated)
    return UpdateFileResponse(
        session_id=session_id,
        file=final_file,
        files=session.files,
        learning_suggestion=learning_suggestion,
    )


@router.patch("/features/bulk", response_model=BulkPatchWithUndoResponse | BulkPatchFeaturesResponse)
def patch_features_bulk(
    session_id: str,
    payload: BulkPatchFeaturesRequest,
    request: Request,
) -> BulkPatchWithUndoResponse | BulkPatchFeaturesResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")
    _require_revision(session, payload.base_rev)
    if payload.with_undo and payload.action != "patch":
        raise ValueError("with_undo applies to the patch action only")

    if payload.action == "restore":
        if payload.undo is None:
            raise ValueError("restore needs the undo a fix returned")
        undo = payload.undo
        check_restorable(features, undo)
        restored = restore_features(features, undo)
        session.feature_collection["features"] = restored
        if changes_anything(undo_between(features, restored)):
            mark_changed(session, "fix_undone")
        validation = _revalidate_session(session)
        manager.save_session(session)
        return BulkPatchFeaturesResponse(
            updated_count=len(undo.features),
            deleted_count=len(features) + len(undo.features) - len(restored),
            validation=validation,
        )

    feature_ids = {str(item) for item in payload.feature_ids}
    if not feature_ids:
        return BulkPatchFeaturesResponse()

    if payload.action == "delete":
        kept = [item for item in features if str(item.get("id")) not in feature_ids]
        deleted = len(features) - len(kept)
        session.feature_collection["features"] = kept
        if deleted:
            mark_changed(session, "features_deleted", deleted)
        manager.save_session(session)
        return BulkPatchFeaturesResponse(updated_count=0, deleted_count=deleted)

    if payload.action == "merge_units":
        selected = [item for item in features if str(item.get("id")) in feature_ids and item.get("feature_type") == "unit"]
        if len(selected) < 2:
            raise ValueError("merge_units requires at least two selected unit features")

        geometries = []
        for item in selected:
            geometry = item.get("geometry")
            if geometry is None:
                continue
            geometries.append(shape(geometry))
        if len(geometries) < 2:
            raise ValueError("merge_units requires at least two unit geometries")

        merged_geometry = unary_union(geometries)
        template = copy.deepcopy(selected[0])
        template["id"] = str(uuid4())
        template["geometry"] = mapping(merged_geometry)
        properties = template.get("properties") or {}
        if payload.merge_name:
            label_payload = {"en": payload.merge_name.strip()}
            if properties.get("name") and isinstance(properties.get("name"), dict):
                existing = properties.get("name")
                label_payload = {**existing, "en": payload.merge_name.strip()}
            properties["name"] = label_payload
        template["properties"] = properties

        kept = [item for item in features if str(item.get("id")) not in feature_ids]
        kept.append(template)
        session.feature_collection["features"] = kept
        mark_changed(session, "units_merged")
        manager.save_session(session)
        return BulkPatchFeaturesResponse(updated_count=1, deleted_count=len(selected), merged_feature_id=template["id"])

    if payload.properties is None and payload.feature_type is None:
        raise ValueError("Bulk patch requires a properties or feature_type payload")

    updated = 0
    changed = 0
    next_features: list[dict[str, Any]] = []
    for item in features:
        if str(item.get("id")) not in feature_ids:
            next_features.append(item)
            continue
        copied = copy.deepcopy(item)
        retyped = _retype_feature(copied, payload.feature_type) if payload.feature_type is not None else False
        if payload.properties is not None:
            merged = _merge_properties(copied.get("properties") or {}, payload.properties)
            copied["properties"] = conform_properties(merged, copied["feature_type"]) if retyped else merged
        updated += 1
        changed += not same_content(copied, item)
        next_features.append(copied)
    if payload.with_undo:
        next_features, undo = finish_fix(features, next_features)
        session.feature_collection["features"] = next_features
        if changes_anything(undo):
            mark_changed(session)
        validation = _revalidate_session(session)
        manager.save_session(session)
        return BulkPatchWithUndoResponse(
            updated_count=updated,
            undo=undo,
            validation=validation,
            content_rev=session.content_rev,
        )
    session.feature_collection["features"] = next_features
    if changed:
        mark_changed(session, "features_edited", changed)
    manager.save_session(session)
    return BulkPatchFeaturesResponse(updated_count=updated, deleted_count=0)


@router.post("/overlaps/resolve", response_model=ResolveUnitOverlapsResponse)
def resolve_unit_overlap(
    session_id: str,
    payload: ResolveUnitOverlapRequest,
    request: Request,
) -> ResolveUnitOverlapsResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")
    before = list(features)

    updated_count, deleted_count = _clip_unit_overlap(
        features=features,
        keep_feature_id=payload.keep_feature_id,
        clip_feature_id=payload.clip_feature_id,
    )
    resolved = bool(updated_count or deleted_count)
    features, removed = prune_empty_geometry_features(features)
    features, undo = finish_fix(before, features)
    session.feature_collection["features"] = features
    if resolved or removed:
        mark_changed(session, "overlaps_resolved")
    validation = _revalidate_session(session)
    manager.save_session(session)
    return ResolveUnitOverlapsResponse(
        session_id=session_id,
        resolved_pairs=1 if resolved else 0,
        updated_count=updated_count,
        deleted_count=deleted_count + len(removed),
        skipped_count=0 if resolved else 1,
        validation=validation,
        undo=undo,
    )


@router.post("/overlaps/fix-safe", response_model=ResolveUnitOverlapsResponse)
def resolve_unit_overlaps_safe(
    session_id: str, request: Request, base_rev: int | None = None
) -> ResolveUnitOverlapsResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")
    _require_revision(session, base_rev)

    before = list(features)
    validation = current_validation(session) or validate_feature_collection(session.feature_collection)
    seen_pairs: set[tuple[str, str]] = set()
    overlap_pairs: list[tuple[str, str]] = []
    for issue in validation.warnings:
        if issue.check != "overlapping_units" or not issue.feature_id or not issue.related_feature_id:
            continue
        pair = tuple(sorted([issue.feature_id, issue.related_feature_id]))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        overlap_pairs.append(pair)

    resolved_pairs = 0
    updated_count = 0
    deleted_count = 0
    skipped_count = 0

    for left_id, right_id in overlap_pairs:
        left_pair = _feature_by_id(features, left_id)
        right_pair = _feature_by_id(features, right_id)
        if left_pair is None or right_pair is None:
            skipped_count += 1
            continue

        _, left_feature = left_pair
        _, right_feature = right_pair
        choice = _choose_safe_overlap_resolution(left_feature, right_feature)
        if choice is None:
            skipped_count += 1
            continue
        keep_id, clip_id = choice
        try:
            updated_delta, deleted_delta = _clip_unit_overlap(features, keep_id, clip_id)
        except ValueError:
            skipped_count += 1
            continue
        if updated_delta == 0 and deleted_delta == 0:
            skipped_count += 1
            continue

        resolved_pairs += 1
        updated_count += updated_delta
        deleted_count += deleted_delta

    features, removed = prune_empty_geometry_features(features)
    deleted_count += len(removed)
    features, undo = finish_fix(before, features)
    session.feature_collection["features"] = features
    if resolved_pairs or removed:
        mark_changed(session, "overlaps_resolved", max(resolved_pairs, 1))
    revalidation = _revalidate_session(session)
    manager.save_session(session)
    return ResolveUnitOverlapsResponse(
        session_id=session_id,
        resolved_pairs=resolved_pairs,
        updated_count=updated_count,
        deleted_count=deleted_count,
        skipped_count=skipped_count,
        validation=revalidation,
        undo=undo,
    )


@router.get("/features/{feature_id}", response_model=FeatureResponse)
def get_feature(session_id: str, feature_id: str, request: Request) -> FeatureResponse:
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise NotFoundError("Feature not found")
    return FeatureResponse.model_validate(features[index])


@router.patch("/features/{feature_id}", response_model=FeatureResponse)
def patch_feature(
    session_id: str,
    feature_id: str,
    payload: PatchFeatureRequest,
    request: Request,
) -> FeatureResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise NotFoundError("Feature not found")

    updated = copy.deepcopy(features[index])
    changed_fields = payload.model_fields_set
    # Order matters: the target type is validated against the incoming geometry,
    # the re-type then reshapes properties, and an explicit properties payload
    # merges last so one request can set the type and its new category together.
    if "geometry" in changed_fields:
        updated["geometry"] = payload.geometry
    retyped = _retype_feature(updated, payload.feature_type) if payload.feature_type is not None else False
    if "properties" in changed_fields and payload.properties is not None:
        merged = _merge_properties(updated.get("properties") or {}, payload.properties)
        # The editor posts the whole property bag it was showing, which still
        # holds the old type's fields; re-conforming keeps the new type's schema
        # authoritative instead of letting them leak back in.
        updated["properties"] = conform_properties(merged, updated["feature_type"]) if retyped else merged

    if not same_content(updated, features[index]):
        features[index] = updated
        session.feature_collection["features"] = features
        mark_changed(session, "features_edited")
    manager.save_session(session)
    return FeatureResponse.model_validate(updated)


@router.delete("/features/{feature_id}")
def delete_feature(session_id: str, feature_id: str, request: Request) -> dict[str, Any]:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise NotFoundError("Feature not found")

    deleted = features.pop(index)
    session.feature_collection["features"] = features
    mark_changed(session, "features_deleted")
    manager.save_session(session)
    return {"session_id": session_id, "deleted_id": deleted.get("id")}
