"""Export endpoint for IMDF archive downloads."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from backend.src.autofix import apply_autofix
from backend.src.exporter import build_export_archive
from backend.src.schemas import AutofixRequest, AutofixResponse, ShapefileExportRequest, ValidationResponse
from backend.src.session import SessionManager
from backend.src.shapefile_exporter import build_shapefile_export_archive
from backend.src.validator import annotate_feature_collection_with_validation, validate_feature_collection


router = APIRouter(prefix="/api/session/{session_id}", tags=["export"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


@router.post("/validate", response_model=ValidationResponse)
def validate_session(session_id: str, request: Request) -> ValidationResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    session.validation = validation
    manager.save_session(session)
    return validation


@router.post("/autofix", response_model=AutofixResponse)
def autofix_session(
    session_id: str,
    payload: AutofixRequest,
    request: Request,
) -> AutofixResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    validation = session.validation or validate_feature_collection(session.feature_collection)
    updated, fixes_applied, prompts = apply_autofix(
        feature_collection=session.feature_collection,
        validation=validation,
        apply_prompted=payload.apply_prompted,
    )
    session.feature_collection = updated
    revalidation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, revalidation)
    session.validation = revalidation
    manager.save_session(session)

    remaining_prompts = [] if payload.apply_prompted else prompts
    return AutofixResponse(
        fixes_applied=fixes_applied,
        fixes_requiring_confirmation=remaining_prompts,
        total_fixed=len(fixes_applied),
        total_requiring_confirmation=len(remaining_prompts),
        revalidation=revalidation,
    )


@router.get("/export")
def export_imdf(session_id: str, request: Request) -> Response:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    session.validation = validation
    if validation.summary.error_count > 0:
        manager.save_session(session)
        raise ValueError("Export blocked: unresolved validation errors remain.")

    payload, filename = build_export_archive(session)
    manager.save_session(session)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/export/shapefiles")
def export_shapefiles(
    session_id: str,
    payload: ShapefileExportRequest,
    request: Request,
) -> Response:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    archive, filename = build_shapefile_export_archive(session=session, request=payload)
    manager.save_session(session)
    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
