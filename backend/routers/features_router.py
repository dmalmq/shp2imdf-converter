"""Feature retrieval endpoints."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Request
from shapely import make_valid
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.src.detector import (
    detect_files,
    infer_learning_suggestion,
    load_keyword_map,
    merge_learned_keywords,
    sync_feature_types,
)
from backend.src.schemas import (
    BulkPatchFeaturesRequest,
    BulkPatchFeaturesResponse,
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
from backend.src.session import SessionManager
from backend.src.validator import annotate_feature_collection_with_validation, validate_feature_collection


router = APIRouter(prefix="/api/session/{session_id}", tags=["features"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _merged_keyword_map(request: Request, session_learned_keywords: dict[str, str]) -> dict[str, set[str]]:
    base = load_keyword_map(request.app.state.filename_keywords_path)
    return merge_learned_keywords(base_keywords=base, learned_keywords=session_learned_keywords)


def _get_session_or_raise(session_id: str, request: Request):
    session = _session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")
    return session


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
    session.validation = validation
    return validation


@router.get("/features", response_model=FeatureCollectionResponse)
def get_features(session_id: str, request: Request) -> FeatureCollectionResponse:
    session = _get_session_or_raise(session_id, request)
    return FeatureCollectionResponse.model_validate(session.feature_collection)


@router.get("/files")
def get_files(session_id: str, request: Request) -> dict:
    session = _get_session_or_raise(session_id, request)
    return {"session_id": session_id, "files": [item.model_dump() for item in session.files]}


@router.post("/detect", response_model=DetectResponse)
def detect_all(session_id: str, request: Request) -> DetectResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)

    keyword_map = _merged_keyword_map(request, session.learned_keywords)
    session.files = detect_files(session.files, keyword_map, preserve_manual_levels=True)
    source_collection = session.source_feature_collection or session.feature_collection
    session.source_feature_collection = sync_feature_types(source_collection, session.files)
    if session.wizard.generation_status != "generated":
        session.feature_collection = sync_feature_types(session.feature_collection, session.files)
    manager.save_session(session)

    return DetectResponse(session_id=session_id, files=session.files)


@router.patch("/files/{stem}", response_model=UpdateFileResponse)
def patch_file(stem: str, session_id: str, payload: UpdateFileRequest, request: Request) -> UpdateFileResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)

    file_index = next((index for index, item in enumerate(session.files) if item.stem == stem), None)
    if file_index is None:
        raise KeyError("File stem not found")

    current: ImportedFile = session.files[file_index]
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

    session.files[file_index] = updated
    learning_suggestion = None

    if payload.apply_learning:
        keyword = (payload.learning_keyword or "").strip().lower()
        feature_type = (payload.detected_type or updated.detected_type or "").strip().lower()
        if not keyword:
            raise ValueError("learning_keyword is required when apply_learning=true")
        if not feature_type:
            raise ValueError("detected_type is required when apply_learning=true")
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

    source_collection = session.source_feature_collection or session.feature_collection
    session.source_feature_collection = sync_feature_types(source_collection, session.files)
    if session.wizard.generation_status != "generated":
        session.feature_collection = sync_feature_types(session.feature_collection, session.files)
    manager.save_session(session)

    final_file = next((item for item in session.files if item.stem == stem), updated)
    return UpdateFileResponse(
        session_id=session_id,
        file=final_file,
        files=session.files,
        learning_suggestion=learning_suggestion,
    )


@router.patch("/features/bulk", response_model=BulkPatchFeaturesResponse)
def patch_features_bulk(
    session_id: str,
    payload: BulkPatchFeaturesRequest,
    request: Request,
) -> BulkPatchFeaturesResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    feature_ids = {str(item) for item in payload.feature_ids}
    if not feature_ids:
        return BulkPatchFeaturesResponse()

    if payload.action == "delete":
        kept = [item for item in features if str(item.get("id")) not in feature_ids]
        deleted = len(features) - len(kept)
        session.feature_collection["features"] = kept
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
        manager.save_session(session)
        return BulkPatchFeaturesResponse(updated_count=1, deleted_count=len(selected), merged_feature_id=template["id"])

    if payload.properties is None:
        raise ValueError("Bulk patch requires properties payload")

    updated = 0
    next_features: list[dict[str, Any]] = []
    for item in features:
        if str(item.get("id")) not in feature_ids:
            next_features.append(item)
            continue
        copied = copy.deepcopy(item)
        copied["properties"] = _merge_properties(copied.get("properties") or {}, payload.properties)
        updated += 1
        next_features.append(copied)
    session.feature_collection["features"] = next_features
    manager.save_session(session)
    return BulkPatchFeaturesResponse(updated_count=updated, deleted_count=0)


@router.post("/overlaps/resolve", response_model=ResolveUnitOverlapsResponse)
def resolve_unit_overlap(
    session_id: str,
    payload: ResolveUnitOverlapRequest,
    request: Request,
) -> ResolveUnitOverlapsResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    updated_count, deleted_count = _clip_unit_overlap(
        features=features,
        keep_feature_id=payload.keep_feature_id,
        clip_feature_id=payload.clip_feature_id,
    )
    session.feature_collection["features"] = features
    validation = _revalidate_session(session)
    manager.save_session(session)
    return ResolveUnitOverlapsResponse(
        session_id=session_id,
        resolved_pairs=1 if (updated_count or deleted_count) else 0,
        updated_count=updated_count,
        deleted_count=deleted_count,
        skipped_count=0 if (updated_count or deleted_count) else 1,
        validation=validation,
    )


@router.post("/overlaps/fix-safe", response_model=ResolveUnitOverlapsResponse)
def resolve_unit_overlaps_safe(session_id: str, request: Request) -> ResolveUnitOverlapsResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    validation = session.validation or validate_feature_collection(session.feature_collection)
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

    session.feature_collection["features"] = features
    revalidation = _revalidate_session(session)
    manager.save_session(session)
    return ResolveUnitOverlapsResponse(
        session_id=session_id,
        resolved_pairs=resolved_pairs,
        updated_count=updated_count,
        deleted_count=deleted_count,
        skipped_count=skipped_count,
        validation=revalidation,
    )


@router.get("/features/{feature_id}", response_model=FeatureResponse)
def get_feature(session_id: str, feature_id: str, request: Request) -> FeatureResponse:
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise KeyError("Feature not found")
    return FeatureResponse.model_validate(features[index])


@router.patch("/features/{feature_id}", response_model=FeatureResponse)
def patch_feature(
    session_id: str,
    feature_id: str,
    payload: PatchFeatureRequest,
    request: Request,
) -> FeatureResponse:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise KeyError("Feature not found")

    updated = copy.deepcopy(features[index])
    changed_fields = payload.model_fields_set
    if "properties" in changed_fields and payload.properties is not None:
        updated["properties"] = _merge_properties(updated.get("properties") or {}, payload.properties)
    if "geometry" in changed_fields:
        updated["geometry"] = payload.geometry

    features[index] = updated
    session.feature_collection["features"] = features
    manager.save_session(session)
    return FeatureResponse.model_validate(updated)


@router.delete("/features/{feature_id}")
def delete_feature(session_id: str, feature_id: str, request: Request) -> dict[str, Any]:
    manager = _session_manager(request)
    session = _get_session_or_raise(session_id, request)
    features = session.feature_collection.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Session feature collection is malformed")

    index = _find_feature_index(features, feature_id)
    if index is None:
        raise KeyError("Feature not found")

    deleted = features.pop(index)
    session.feature_collection["features"] = features
    manager.save_session(session)
    return {"session_id": session_id, "deleted_id": deleted.get("id")}
