"""Feature retrieval endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.src.detector import (
    detect_files,
    infer_learning_suggestion,
    load_keyword_map,
    merge_learned_keywords,
    sync_feature_types,
)
from backend.src.schemas import (
    DetectResponse,
    FeatureCollectionResponse,
    ImportedFile,
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


@router.get("/features", response_model=FeatureCollectionResponse)
def get_features(session_id: str, request: Request) -> FeatureCollectionResponse:
    session = _session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")
    return FeatureCollectionResponse.model_validate(session.feature_collection)


@router.get("/files")
def get_files(session_id: str, request: Request) -> dict:
    session = _session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")
    return {"session_id": session_id, "files": [item.model_dump() for item in session.files]}


@router.post("/detect", response_model=DetectResponse)
def detect_all(session_id: str, request: Request) -> DetectResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    keyword_map = _merged_keyword_map(request, session.learned_keywords)
    session.files = detect_files(session.files, keyword_map, preserve_manual_levels=True)
    session.feature_collection = sync_feature_types(session.feature_collection, session.files)
    manager.save_session(session)

    return DetectResponse(session_id=session_id, files=session.files)


@router.patch("/files/{stem}", response_model=UpdateFileResponse)
def patch_file(stem: str, session_id: str, payload: UpdateFileRequest, request: Request) -> UpdateFileResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

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

    session.feature_collection = sync_feature_types(session.feature_collection, session.files)
    manager.save_session(session)

    final_file = next((item for item in session.files if item.stem == stem), updated)
    return UpdateFileResponse(
        session_id=session_id,
        file=final_file,
        files=session.files,
        learning_suggestion=learning_suggestion,
    )
