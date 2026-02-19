"""Feature retrieval endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.src.schemas import FeatureCollectionResponse
from backend.src.session import SessionManager


router = APIRouter(prefix="/api/session/{session_id}", tags=["features"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


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

