"""Feature retrieval endpoints."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Request
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
    UpdateFileRequest,
    UpdateFileResponse,
)
from backend.src.session import SessionManager


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
        session.learned_keywords[keyword] = feature_type
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
