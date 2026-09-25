"""Export endpoint for IMDF archive downloads."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response
from shapely.affinity import translate
from shapely.geometry import mapping, shape
from shapely.ops import nearest_points

from backend.routers.common import get_session_or_raise, session_manager
from backend.src.errors import NotFoundError
from backend.src.autofix import apply_autofix
from backend.src.exporter import build_export_archive
from backend.src.feature_undo import finish_fix
from backend.src.projects import current_validation, mark_changed, mark_delivered, mark_validated
from backend.src.schemas import AutofixRequest, AutofixResponse, SessionRecord, ShapefileExportRequest, SnapOpeningRequest, SnapOpeningResponse, ValidationResponse
from backend.src.shapefile_exporter import build_qgis_project_archive, build_shapefile_export_archive
from backend.src.validator import annotate_feature_collection_with_validation, validate_feature_collection


router = APIRouter(prefix="/api/session/{session_id}", tags=["export"])


def _blocker_count(session: SessionRecord) -> int:
    """Errors in what is being delivered; a stale validation is neither trusted nor stored."""
    validation = current_validation(session) or validate_feature_collection(session.feature_collection)
    return validation.summary.error_count


@router.get("/validation", response_model=ValidationResponse | None)
def stored_validation(session_id: str, request: Request) -> ValidationResponse | None:
    """The last validation, while nothing has changed since it ran."""
    return current_validation(get_session_or_raise(session_id, request))


@router.post("/validate", response_model=ValidationResponse)
def validate_session(session_id: str, request: Request) -> ValidationResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    mark_validated(session, validation)
    manager.save_session(session)
    return validation


@router.post("/autofix", response_model=AutofixResponse)
def autofix_session(
    session_id: str,
    payload: AutofixRequest,
    request: Request,
) -> AutofixResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    validation = current_validation(session) or validate_feature_collection(session.feature_collection)
    updated, fixes_applied, prompts = apply_autofix(
        feature_collection=session.feature_collection,
        validation=validation,
        apply_prompted=payload.apply_prompted,
    )
    updated["features"], undo = finish_fix(session.feature_collection.get("features", []), updated.get("features", []))
    session.feature_collection = updated
    if fixes_applied:
        mark_changed(session)
    revalidation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, revalidation)
    mark_validated(session, revalidation)
    manager.save_session(session)

    remaining_prompts = [] if payload.apply_prompted else prompts
    return AutofixResponse(
        fixes_applied=fixes_applied,
        fixes_requiring_confirmation=remaining_prompts,
        total_fixed=len(fixes_applied),
        total_requiring_confirmation=len(remaining_prompts),
        revalidation=revalidation,
        undo=undo,
    )


@router.get("/export")
def export_imdf(session_id: str, request: Request, ext: str = "imdf") -> Response:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    mark_validated(session, validation)

    payload, filename = build_export_archive(session, extension=ext)
    mark_delivered(session, "imdf_zip" if ext == "zip" else "imdf", validation.summary.error_count)
    manager.save_session(session)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/snap_opening", response_model=SnapOpeningResponse)
def snap_opening(session_id: str, payload: SnapOpeningRequest, request: Request) -> SnapOpeningResponse:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    features = session.feature_collection.get("features", [])
    opening_index = next(
        (index for index, f in enumerate(features) if isinstance(f, dict) and str(f.get("id")) == payload.opening_id),
        None,
    )
    unit_row = next((f for f in features if isinstance(f, dict) and str(f.get("id")) == payload.unit_id), None)
    if opening_index is None or unit_row is None:
        raise NotFoundError("Opening or unit feature not found.")
    opening_row = features[opening_index]

    opening_geom = shape(opening_row["geometry"])
    unit_boundary = shape(unit_row["geometry"]).boundary
    nearest_pt = nearest_points(opening_geom.centroid, unit_boundary)[1]
    dx = nearest_pt.x - opening_geom.centroid.x
    dy = nearest_pt.y - opening_geom.centroid.y
    snapped = translate(opening_geom, xoff=dx, yoff=dy)
    moved = [*features[:opening_index], {**opening_row, "geometry": mapping(snapped)}, *features[opening_index + 1 :]]
    session.feature_collection["features"], undo = finish_fix(features, moved)
    if undo.features:
        mark_changed(session)

    validation = validate_feature_collection(session.feature_collection)
    session.feature_collection = annotate_feature_collection_with_validation(session.feature_collection, validation)
    mark_validated(session, validation)
    manager.save_session(session)
    return SnapOpeningResponse(session_id=session_id, validation=validation, undo=undo)


@router.post("/export/shapefiles")
def export_shapefiles(
    session_id: str,
    payload: ShapefileExportRequest,
    request: Request,
) -> Response:
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    archive, filename = build_shapefile_export_archive(session=session, request=payload)
    mark_delivered(session, f"shapefiles:{payload.profile}", _blocker_count(session))
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
    manager = session_manager(request)
    session = get_session_or_raise(session_id, request)

    payload.profile = "odc2026"
    archive, filename = build_qgis_project_archive(session=session, request=payload)
    mark_delivered(session, "qgis", _blocker_count(session))
    manager.save_session(session)
    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )