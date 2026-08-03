"""Import endpoints."""

from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import shutil
from typing import Annotated
from urllib.parse import quote
import zipfile

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import Response

from backend.src.detector import sync_feature_types
from backend.src.illustrator_export import (
    ExportFormats,
    build_georeferenced_bundle,
    build_preview,
)
from backend.src.illustrator_georeference import (
    SimilarityTransform,
    resolve_working_crs,
    zone_label,
)
from backend.src.illustrator_importer import convert_ai_to_geopackage_bundle, parse_ai
from backend.src.illustrator_store import ConversionStore
from backend.src.imdf_reader import read_imdf_zip
from backend.src.imdf_shapefile_importer import import_imdf_shapefile_blobs
from backend.src.importer import import_file_blobs
from backend.src.placements import PlacementStore
from backend.src.schemas import (
    CleanupSummary,
    GeocodeSearchResponse,
    IllustratorExportRequest,
    IllustratorPreviewResponse,
    ImportImdfResponse,
    ImportResponse,
    PlacementItem,
    PlacementListResponse,
    PlacementRequest,
    TransformPayload,
)
from backend.src.session import SessionManager


router = APIRouter(prefix="/api", tags=["import"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _keyword_config_path(request: Request) -> Path:
    return request.app.state.filename_keywords_path


def _max_upload_bytes(request: Request) -> int:
    value = getattr(request.app.state, "max_upload_bytes", 1024 * 1024 * 1024)
    return int(value)


def _illustrator_store(request: Request) -> ConversionStore:
    return request.app.state.illustrator_store


def _validate_ai_upload(request: Request, file: UploadFile, payload: bytes) -> str:
    """Shared guard for both Illustrator entry points; returns the filename."""
    if not payload:
        raise ValueError("The uploaded file is empty.")
    if len(payload) > _max_upload_bytes(request):
        raise ValueError("Upload exceeds configured limit (MAX_UPLOAD_MB).")
    name = file.filename or "illustrator.ai"
    if not name.lower().endswith((".ai", ".pdf")):
        raise ValueError("Upload an Adobe Illustrator (.ai) or PDF file.")
    if not payload.lstrip()[:5].startswith(b"%PDF"):
        raise ValueError(
            "Not a PDF-based Illustrator file. Re-save the .ai with 'Create PDF Compatible File' enabled."
        )
    return name


def _session_uploads_dir(request: Request) -> Path:
    path = getattr(request.app.state, "session_uploads_dir", Path("./data/session_uploads"))
    directory = Path(path)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _persist_session_upload_artifacts(
    session_id: str,
    file_blobs: list[tuple[str, bytes]],
    uploads_root: Path,
) -> Path:
    target = uploads_root / session_id
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)

    for filename, payload in file_blobs:
        source_name = Path(filename).name
        candidate = source_name
        collision_index = 1
        while (target / candidate).exists():
            stem = Path(source_name).stem
            suffix = Path(source_name).suffix
            candidate = f"{stem}_{collision_index}{suffix}"
            collision_index += 1
        (target / candidate).write_bytes(payload)
    return target


def _expand_upload(upload: UploadFile, payload: bytes) -> list[tuple[str, bytes]]:
    if upload.filename and upload.filename.lower().endswith(".zip"):
        blobs: list[tuple[str, bytes]] = []
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                blobs.append((Path(info.filename).name, archive.read(info.filename)))
        return blobs
    return [(upload.filename or "upload.bin", payload)]


async def _read_uploaded_blobs(request: Request, files: list[UploadFile]) -> list[tuple[str, bytes]]:
    if not files:
        raise ValueError("No files were uploaded.")

    max_upload_bytes = _max_upload_bytes(request)
    raw_total = 0
    expanded_total = 0
    raw_blobs: list[tuple[str, bytes]] = []
    for upload in files:
        payload = await upload.read()
        raw_total += len(payload)
        if raw_total > max_upload_bytes:
            raise ValueError("Upload exceeds configured limit (MAX_UPLOAD_MB).")

        expanded = _expand_upload(upload, payload)
        expanded_total += sum(len(content) for _, content in expanded)
        if expanded_total > max_upload_bytes:
            raise ValueError("Expanded upload exceeds configured limit (MAX_UPLOAD_MB).")
        raw_blobs.extend(expanded)
    return raw_blobs


@router.post("/import/imdf", response_model=ImportImdfResponse, status_code=201)
async def import_imdf(
    request: Request,
    file: Annotated[UploadFile, File(description="Exported IMDF .zip archive")],
) -> ImportImdfResponse:
    max_upload_bytes = _max_upload_bytes(request)
    payload = await file.read()
    if len(payload) > max_upload_bytes:
        raise ValueError("Upload exceeds configured limit (MAX_UPLOAD_MB).")

    feature_collection = read_imdf_zip(payload, max_uncompressed_bytes=max_upload_bytes)
    feature_count = len(feature_collection["features"])

    manager = _session_manager(request)
    session = manager.create_session(
        files=[],
        cleanup_summary=CleanupSummary(),
        feature_collection=feature_collection,
    )
    session.wizard.generation_status = "generated"
    manager.save_session(session)

    return ImportImdfResponse(session_id=session.session_id, feature_count=feature_count)


@router.post("/convert/illustrator")
async def convert_illustrator(
    request: Request,
    file: Annotated[UploadFile, File(description="Adobe Illustrator (.ai) or PDF file")],
) -> Response:
    """Convert an Illustrator (.ai / PDF) file into a downloadable zip.

    The zip bundles a GeoPackage (one layer per Illustrator layer; filled paths
    become polygons, stroked paths become lines, colors preserved as attributes)
    and a styled QGIS project (.qgs) that orders the layers like the Illustrator
    stack and colors each layer from its fill_color / stroke_color attribute.
    """
    payload = await file.read()
    name = _validate_ai_upload(request, file, payload)

    zip_bytes, filename, report = convert_ai_to_geopackage_bundle(payload, name)
    # HTTP headers must be latin-1; keep a plain ASCII fallback and carry the
    # real (possibly Japanese) name via RFC 5987 filename*.
    ascii_name = filename.encode("ascii", "ignore").decode() or "output.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
            # ensure_ascii keeps non-ASCII layer names out of the raw header bytes.
            "X-Conversion-Report": json.dumps(report.to_dict()),
        },
    )


@router.post("/convert/illustrator/preview", response_model=IllustratorPreviewResponse)
async def preview_illustrator(
    request: Request,
    file: Annotated[UploadFile, File(description="Adobe Illustrator (.ai) or PDF file")],
) -> IllustratorPreviewResponse:
    """Parse an Illustrator file once and cache it for placement and export."""
    payload = await file.read()
    name = _validate_ai_upload(request, file, payload)

    cached = _illustrator_store(request).put(parse_ai(payload, name))
    preview = build_preview(cached)
    # Placement has no location yet; the client re-resolves the zone once the
    # user picks a search result, passing the prefecture code from Nominatim.
    suggested = resolve_working_crs(139.7671, 35.6812, None)
    return IllustratorPreviewResponse(
        conversion_id=cached.conversion_id,
        report=cached.report,
        layers=preview["layers"],
        artwork_bounds=preview["artwork_bounds"],
        preview=preview["preview"],
        preview_features=preview["preview_features"],
        total_features=preview["total_features"],
        suggested_crs=suggested,
        suggested_crs_label=zone_label(suggested),
    )


@router.post("/convert/illustrator/{conversion_id}/export")
async def export_illustrator(
    conversion_id: str,
    request: Request,
    payload: IllustratorExportRequest,
) -> Response:
    """Apply a placement to a cached conversion and return a zipped bundle."""
    if payload.formats.qgis and not payload.formats.geopackage:
        raise ValueError(
            "A QGIS project needs the GeoPackage; enable it or disable the project."
        )
    if not (payload.formats.geopackage or payload.formats.shapefile or payload.formats.qgis):
        raise ValueError("Select at least one output format.")

    cached = _illustrator_store(request).get(conversion_id)
    transform = SimilarityTransform(
        artwork_anchor=(
            payload.transform.artwork_anchor[0],
            payload.transform.artwork_anchor[1],
        ),
        map_anchor=(payload.transform.map_anchor[0], payload.transform.map_anchor[1]),
        rotation_deg=payload.transform.rotation_deg,
        metres_per_point=payload.transform.metres_per_point,
        working_crs=payload.transform.working_crs,
    )
    zip_bytes, filename = build_georeferenced_bundle(
        cached,
        transform,
        payload.output_crs,
        ExportFormats(
            geopackage=payload.formats.geopackage,
            shapefile=payload.formats.shapefile,
            qgis=payload.formats.qgis,
        ),
    )
    ascii_name = filename.encode("ascii", "ignore").decode() or "output.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
            ),
        },
    )


@router.get("/geocode", response_model=GeocodeSearchResponse)
async def geocode(
    request: Request,
    query: str,
    language: str = "ja",
    limit: int = 5,
) -> GeocodeSearchResponse:
    """Address search with no session, for placing artwork."""
    from backend.routers.wizard_router import _match_to_schema
    from backend.src.geocoding import GeocodingError

    geocoder = getattr(request.app.state, "geocoder", None)
    if geocoder is None:
        raise GeocodingError(
            "Geocoding is disabled on this server.",
            code="GEOCODER_DISABLED",
            status_code=503,
        )
    cleaned = query.strip()
    if not cleaned:
        return GeocodeSearchResponse(query="", language=language, results=[])
    matches = geocoder.search(cleaned, language=language, limit=max(1, min(limit, 10)))
    return GeocodeSearchResponse(
        query=cleaned, language=language, results=[_match_to_schema(m) for m in matches]
    )


def _placement_store(request: Request) -> PlacementStore:
    return request.app.state.placement_store


def _placement_item(placement) -> PlacementItem:
    return PlacementItem(
        id=placement.id,
        name=placement.name,
        transform=TransformPayload(**placement.transform),
        artwork_bounds=placement.artwork_bounds,
        created_at=placement.created_at,
        updated_at=placement.updated_at,
    )


@router.get("/placements", response_model=PlacementListResponse)
async def list_placements(request: Request) -> PlacementListResponse:
    return PlacementListResponse(
        placements=[_placement_item(p) for p in _placement_store(request).list_all()]
    )


@router.post("/placements", response_model=PlacementItem, status_code=201)
async def create_placement(request: Request, payload: PlacementRequest) -> PlacementItem:
    return _placement_item(
        _placement_store(request).create(
            payload.name, payload.transform.model_dump(), payload.artwork_bounds
        )
    )


@router.put("/placements/{placement_id}", response_model=PlacementItem)
async def update_placement(
    placement_id: int, request: Request, payload: PlacementRequest
) -> PlacementItem:
    return _placement_item(
        _placement_store(request).update(
            placement_id, payload.name, payload.transform.model_dump(), payload.artwork_bounds
        )
    )


@router.delete("/placements/{placement_id}", status_code=204)
async def delete_placement(placement_id: int, request: Request) -> Response:
    _placement_store(request).delete(placement_id)
    return Response(status_code=204)


@router.post("/import", response_model=ImportResponse, status_code=201)
async def import_files(
    request: Request,
    files: Annotated[list[UploadFile], File(description="Shapefile components, GeoPackages, or a zip file")],
) -> ImportResponse:
    raw_blobs = await _read_uploaded_blobs(request, files)
    manager = _session_manager(request)
    artifacts = import_file_blobs(raw_blobs, filename_keywords_path=_keyword_config_path(request))
    source_feature_collection = sync_feature_types(artifacts.source_feature_collection, artifacts.files)
    feature_collection = sync_feature_types(artifacts.feature_collection, artifacts.files)
    session = manager.create_session(
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        feature_collection=feature_collection,
        source_feature_collection=source_feature_collection,
        warnings=artifacts.warnings,
    )
    artifact_directory = _persist_session_upload_artifacts(
        session_id=session.session_id,
        file_blobs=raw_blobs,
        uploads_root=_session_uploads_dir(request),
    )
    session.upload_artifact_dir = str(artifact_directory)
    manager.save_session(session)
    return ImportResponse(
        session_id=session.session_id,
        import_profile=session.import_profile,
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        warnings=artifacts.warnings,
    )


@router.post("/import/imdf-shapefiles", response_model=ImportResponse, status_code=201)
async def import_imdf_shapefiles(
    request: Request,
    files: Annotated[list[UploadFile], File(description="IMDF-schema shapefile components or a zip file")],
) -> ImportResponse:
    raw_blobs = await _read_uploaded_blobs(request, files)
    manager = _session_manager(request)
    artifacts = import_imdf_shapefile_blobs(raw_blobs, filename_keywords_path=_keyword_config_path(request))
    session = manager.create_session(
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        feature_collection=artifacts.feature_collection,
        source_feature_collection=artifacts.source_feature_collection,
        warnings=artifacts.warnings,
        import_profile="imdf_shapefile",
    )
    session.wizard.generation_status = "generated"
    artifact_directory = _persist_session_upload_artifacts(
        session_id=session.session_id,
        file_blobs=raw_blobs,
        uploads_root=_session_uploads_dir(request),
    )
    session.upload_artifact_dir = str(artifact_directory)
    manager.save_session(session)
    return ImportResponse(
        session_id=session.session_id,
        import_profile=session.import_profile,
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        warnings=artifacts.warnings,
    )
