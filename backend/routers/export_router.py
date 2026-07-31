"""Export endpoint for IMDF archive downloads."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response
from shapely.affinity import translate
from shapely.geometry import mapping, shape
from shapely.ops import nearest_points

from backend.src.autofix import apply_autofix
from backend.src.exporter import build_export_archive
from backend.src.schemas import AutofixRequest, AutofixResponse, ShapefileExportRequest, SnapOpeningRequest, SnapOpeningResponse, ValidationResponse
from backend.src.session import SessionManager
from backend.src.shapefile_exporter import build_qgis_project_archive, build_shapefile_export_archive
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
def export_imdf(session_id: str, request: Request, ext: str = "imdf") -> Response:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    session.validation = validation

    payload, filename = build_export_archive(session, extension=ext)
    manager.save_session(session)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/snap_opening", response_model=SnapOpeningResponse)
def snap_opening(session_id: str, payload: SnapOpeningRequest, request: Request) -> SnapOpeningResponse:
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    features = session.feature_collection.get("features", [])
    opening_row = next((f for f in features if isinstance(f, dict) and str(f.get("id")) == payload.opening_id), None)
    unit_row = next((f for f in features if isinstance(f, dict) and str(f.get("id")) == payload.unit_id), None)
    if opening_row is None or unit_row is None:
        raise KeyError("Opening or unit feature not found.")

    opening_geom = shape(opening_row["geometry"])
    unit_boundary = shape(unit_row["geometry"]).boundary
    nearest_pt = nearest_points(opening_geom.centroid, unit_boundary)[1]
    dx = nearest_pt.x - opening_geom.centroid.x
    dy = nearest_pt.y - opening_geom.centroid.y
    snapped = translate(opening_geom, xoff=dx, yoff=dy)
    opening_row["geometry"] = mapping(snapped)

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    session.validation = validation
    manager.save_session(session)
    return SnapOpeningResponse(session_id=session_id, validation=validation)


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



@router.post("/export/qgis")
def export_qgis_project(
    session_id: str,
    payload: ShapefileExportRequest,
    request: Request,
) -> Response:
    """Download a styled QGIS project (.qgz) bundled with its source shapefiles.

    Reuses the Open Data Contest 2026 profile so the layer structure matches
    the standard open-data export exactly.
    """
    manager = _session_manager(request)
    session = manager.get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")

    payload.profile = "odc2026"
    archive, filename = build_qgis_project_archive(session=session, request=payload)
    manager.save_session(session)
    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )