"""Import endpoints."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Annotated
import zipfile

from fastapi import APIRouter, File, Request, UploadFile

from backend.src.detector import sync_feature_types
from backend.src.importer import import_file_blobs
from backend.src.schemas import ImportResponse
from backend.src.session import SessionManager


router = APIRouter(prefix="/api", tags=["import"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _keyword_config_path(request: Request) -> Path:
    return request.app.state.filename_keywords_path


def _max_upload_bytes(request: Request) -> int:
    value = getattr(request.app.state, "max_upload_bytes", 1024 * 1024 * 1024)
    return int(value)


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


@router.post("/import", response_model=ImportResponse, status_code=201)
async def import_files(
    request: Request,
    files: Annotated[list[UploadFile], File(description="Shapefile components or a zip file")],
) -> ImportResponse:
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

    artifacts = import_file_blobs(raw_blobs, filename_keywords_path=_keyword_config_path(request))
    feature_collection = sync_feature_types(artifacts.feature_collection, artifacts.files)
    session = _session_manager(request).create_session(
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        feature_collection=feature_collection,
        warnings=artifacts.warnings,
    )
    return ImportResponse(
        session_id=session.session_id,
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        warnings=artifacts.warnings,
    )
