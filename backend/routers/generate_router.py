"""Draft generation endpoint for Phase 3 summary confirmation."""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.src.schemas import GenerateResponse
from backend.src.session import SessionManager
from backend.src.wizard import build_address_feature, build_building_feature, seed_wizard_state


router = APIRouter(prefix="/api/session/{session_id}", tags=["generate"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


@router.post("/generate", response_model=GenerateResponse)
def generate_draft(session_id: str, request: Request) -> GenerateResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    seed_wizard_state(session)

    project = session.wizard.project
    if project and session.wizard.venue_address_feature is None:
        session.wizard.venue_address_feature = build_address_feature(project.address, fallback_name=project.venue_name)

    generated_features = []
    if session.wizard.venue_address_feature:
        generated_features.append(session.wizard.venue_address_feature)
    generated_features.extend(session.wizard.building_address_features)
    for building in session.wizard.buildings:
        generated_features.append(build_building_feature(building=building, project=project))

    existing_features = []
    for feature in session.feature_collection.get("features", []):
        properties = feature.get("properties") or {}
        if properties.get("_phase3_generated"):
            continue
        existing_features.append(feature)

    session.feature_collection["features"] = [*existing_features, *generated_features]
    session.wizard.generation_status = "draft_ready"
    manager.save_session(session)

    return GenerateResponse(
        session_id=session_id,
        status="draft",
        generated_feature_count=len(generated_features),
        message="Draft generation completed (address/building only). Full geometry generation is implemented in Phase 4.",
    )

