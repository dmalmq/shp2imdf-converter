"""FastAPI entrypoint for Phase 1."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
from pathlib import Path
import os
import shutil
import threading
import time
import zipfile

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routers.export_router import router as export_router
from backend.routers.features_router import router as features_router
from backend.routers.generate_router import router as generate_router
from backend.routers.import_router import router as import_router
from backend.routers.reference_router import router as reference_router
from backend.routers.wizard_router import router as wizard_router
from backend.src.errors import ApiError
from backend.src.geocoding import GeocodingError, build_geocoder
from backend.src.illustrator_export import FloorExportError
from backend.src.illustrator_importer import IllustratorConversionError
from backend.src.illustrator_store import ConversionExpiredError, ConversionStore
from backend.src.placements import DuplicatePlacementError, PlacementStore
from backend.src.qgis_export import QgisExportError, QgisUnavailableError
from backend.src.reference_overlay import ReferenceOverlayStore
from backend.src.schemas import ErrorResponse
from backend.src.session import SessionManager, build_session_backend
from backend.src.session_lock import SessionLockMiddleware

logger = logging.getLogger(__name__)

_CLEANUP_INTERVAL_SECONDS = 3600


def _load_session_manager() -> SessionManager:
    ttl_hours = int(os.getenv("SESSION_TTL_HOURS", "24"))
    max_sessions = int(os.getenv("MAX_SESSIONS", "50"))
    backend_name = os.getenv("SESSION_BACKEND", "filesystem")
    data_dir = os.getenv("SESSION_DATA_DIR", "./data/sessions")
    backend = build_session_backend(backend_name=backend_name, session_data_dir=data_dir)
    return SessionManager(backend=backend, ttl_hours=ttl_hours, max_sessions=max_sessions)


def _load_max_upload_bytes() -> int:
    max_upload_mb = float(os.getenv("MAX_UPLOAD_MB", "1024"))
    if max_upload_mb <= 0:
        raise ValueError("MAX_UPLOAD_MB must be greater than 0")
    return int(max_upload_mb * 1024 * 1024)


def _load_reference_overlay() -> ReferenceOverlayStore:
    raw = os.getenv("REFERENCE_OVERLAY_PATH", "").strip()
    source = Path(raw).expanduser() if raw else None
    cache = Path(os.getenv("TEMP_DATA_DIR", "./data/tmp")) / "reference-overlay"
    cache.mkdir(parents=True, exist_ok=True)
    return ReferenceOverlayStore(source, cache)


async def _session_cleanup_loop(app: FastAPI, stop: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.wait_for(stop.wait(), timeout=_CLEANUP_INTERVAL_SECONDS)
            break
        except TimeoutError:
            pass
        for prune in (app.state.session_manager.prune_expired, app.state.illustrator_store.prune):
            try:
                await asyncio.to_thread(prune)
            except Exception:
                logger.exception("Periodic cleanup failed; retrying next interval")


def _prune_orphan_uploads(uploads_dir: Path, manager: SessionManager) -> None:
    """Delete upload dirs no live session owns, once they are older than the session TTL."""
    try:
        live = {
            Path(summary.upload_artifact_dir).resolve()
            for summary in manager.backend.list_summaries()
            if summary.upload_artifact_dir
        }
        cutoff = time.time() - manager.ttl.total_seconds()
        removed = 0
        for entry in uploads_dir.iterdir():
            try:
                if not entry.is_dir() or entry.resolve() in live or entry.stat().st_mtime >= cutoff:
                    continue
            except OSError:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
        if removed:
            logger.info("Removed %d orphaned upload directories from %s", removed, uploads_dir)
    except Exception:
        logger.exception("Orphaned upload cleanup failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session_manager = _load_session_manager()
    app.state.max_upload_bytes = _load_max_upload_bytes()
    app.state.session_uploads_dir = Path(os.getenv("SESSION_UPLOADS_DIR", "./data/session_uploads"))
    app.state.session_uploads_dir.mkdir(parents=True, exist_ok=True)
    # A daemon thread: thousands of leftover dirs must not hold up startup or shutdown.
    threading.Thread(
        target=_prune_orphan_uploads,
        args=(app.state.session_uploads_dir, app.state.session_manager),
        name="orphan-upload-cleanup",
        daemon=True,
    ).start()
    app.state.filename_keywords_path = Path(__file__).parent / "config" / "filename_keywords.json"
    app.state.unit_categories_path = Path(__file__).parent / "config" / "unit_categories.json"
    app.state.company_mappings_path = Path(__file__).parent / "config" / "company_mappings.json"
    app.state.illustrator_store = ConversionStore(
        root=Path(os.getenv("TEMP_DATA_DIR", "./data/tmp")) / "illustrator",
        ttl_seconds=float(os.getenv("ILLUSTRATOR_CACHE_TTL_MINUTES", "120")) * 60,
        max_entries=int(os.getenv("ILLUSTRATOR_CACHE_MAX_ENTRIES", "20")),
    )
    app.state.placement_store = PlacementStore(
        Path(os.getenv("PLACEMENTS_DB", "./data/placements.db"))
    )
    app.state.reference_overlay = _load_reference_overlay()
    app.state.geocoder = build_geocoder(
        provider=os.getenv("GEOCODER_PROVIDER", "nominatim"),
        base_url=os.getenv("GEOCODER_BASE_URL", "https://nominatim.openstreetmap.org"),
        user_agent=os.getenv("GEOCODER_USER_AGENT", "shp2imdf-converter/1.0"),
        timeout_seconds=float(os.getenv("GEOCODER_TIMEOUT_SECONDS", "8")),
        cache_seconds=int(os.getenv("GEOCODER_CACHE_SECONDS", "900")),
        max_cache_entries=int(os.getenv("GEOCODER_CACHE_MAX_ENTRIES", "512")),
    )
    stop_event = asyncio.Event()
    cleanup_task = asyncio.create_task(_session_cleanup_loop(app, stop_event))
    try:
        yield
    finally:
        stop_event.set()
        await cleanup_task


app = FastAPI(title="SHP to IMDF Converter API", lifespan=lifespan)
app.add_middleware(SessionLockMiddleware)

cors_origins = os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5310")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in cors_origins.split(",") if item.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(import_router)
app.include_router(reference_router)
app.include_router(features_router)
app.include_router(wizard_router)
app.include_router(generate_router)
app.include_router(export_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    payload = ErrorResponse(detail=exc.detail, code=exc.code)
    return JSONResponse(status_code=exc.status_code, content=payload.model_dump())


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="BAD_REQUEST")
    return JSONResponse(status_code=400, content=payload.model_dump())


@app.exception_handler(zipfile.BadZipFile)
async def bad_zip_handler(_: Request, __: zipfile.BadZipFile) -> JSONResponse:
    payload = ErrorResponse(detail="The uploaded file is not a valid ZIP archive.", code="BAD_REQUEST")
    return JSONResponse(status_code=400, content=payload.model_dump())


@app.exception_handler(GeocodingError)
async def geocoding_error_handler(_: Request, exc: GeocodingError) -> JSONResponse:
    payload = ErrorResponse(detail=exc.detail, code=exc.code)
    return JSONResponse(status_code=exc.status_code, content=payload.model_dump())


@app.exception_handler(QgisUnavailableError)
async def qgis_unavailable_handler(_: Request, exc: QgisUnavailableError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="QGIS_UNAVAILABLE")
    return JSONResponse(status_code=503, content=payload.model_dump())


@app.exception_handler(QgisExportError)
async def qgis_export_error_handler(_: Request, exc: QgisExportError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="QGIS_EXPORT_FAILED")
    return JSONResponse(status_code=500, content=payload.model_dump())


@app.exception_handler(IllustratorConversionError)
async def illustrator_conversion_error_handler(_: Request, exc: IllustratorConversionError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="ILLUSTRATOR_CONVERSION_FAILED")
    return JSONResponse(status_code=422, content=payload.model_dump())


@app.exception_handler(ConversionExpiredError)
async def conversion_expired_handler(_: Request, exc: ConversionExpiredError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="CONVERSION_EXPIRED")
    return JSONResponse(status_code=404, content=payload.model_dump())


@app.exception_handler(FloorExportError)
async def floor_export_error_handler(_: Request, exc: FloorExportError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="FLOOR_MISMATCH")
    return JSONResponse(status_code=422, content=payload.model_dump())


@app.exception_handler(DuplicatePlacementError)
async def duplicate_placement_handler(_: Request, exc: DuplicatePlacementError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="PLACEMENT_NAME_TAKEN")
    return JSONResponse(status_code=409, content=payload.model_dump())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="VALIDATION_ERROR")
    return JSONResponse(status_code=422, content=payload.model_dump())


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, __: Exception) -> JSONResponse:
    payload = ErrorResponse(detail="Unexpected server error", code="INTERNAL_ERROR")
    return JSONResponse(status_code=500, content=payload.model_dump())


frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
