"""FastAPI entrypoint for Phase 1."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.routers.features_router import router as features_router
from backend.routers.import_router import router as import_router
from backend.src.schemas import ErrorResponse
from backend.src.session import SessionManager, build_session_backend


class ApiError(Exception):
    """Typed application error for consistent API responses."""

    def __init__(self, detail: str, code: str, status_code: int) -> None:
        self.detail = detail
        self.code = code
        self.status_code = status_code
        super().__init__(detail)


def _load_session_manager() -> SessionManager:
    ttl_hours = int(os.getenv("SESSION_TTL_HOURS", "24"))
    max_sessions = int(os.getenv("MAX_SESSIONS", "5"))
    backend_name = os.getenv("SESSION_BACKEND", "memory")
    data_dir = os.getenv("SESSION_DATA_DIR", "./data/sessions")
    backend = build_session_backend(backend_name=backend_name, session_data_dir=data_dir)
    return SessionManager(backend=backend, ttl_hours=ttl_hours, max_sessions=max_sessions)


async def _session_cleanup_loop(manager: SessionManager, stop: asyncio.Event) -> None:
    while True:
        try:
            await asyncio.wait_for(stop.wait(), timeout=3600)
            break
        except TimeoutError:
            manager.prune_expired()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session_manager = _load_session_manager()
    app.state.filename_keywords_path = Path(__file__).parent / "config" / "filename_keywords.json"
    stop_event = asyncio.Event()
    cleanup_task = asyncio.create_task(_session_cleanup_loop(app.state.session_manager, stop_event))
    try:
        yield
    finally:
        stop_event.set()
        await cleanup_task


app = FastAPI(title="SHP to IMDF Converter API", lifespan=lifespan)

cors_origins = os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[item.strip() for item in cors_origins.split(",") if item.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(import_router)
app.include_router(features_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    payload = ErrorResponse(detail=exc.detail, code=exc.code)
    return JSONResponse(status_code=exc.status_code, content=payload.model_dump())


@app.exception_handler(KeyError)
async def key_error_handler(_: Request, exc: KeyError) -> JSONResponse:
    detail = str(exc).strip("'")
    payload = ErrorResponse(detail=detail, code="SESSION_NOT_FOUND")
    return JSONResponse(status_code=404, content=payload.model_dump())


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
    payload = ErrorResponse(detail=str(exc), code="BAD_REQUEST")
    return JSONResponse(status_code=400, content=payload.model_dump())


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

