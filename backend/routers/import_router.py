"""Import endpoints."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import shutil
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

    manager = _session_manager(request)
    artifacts = import_file_blobs(raw_blobs, filename_keywords_path=_keyword_config_path(request))
    feature_collection = sync_feature_types(artifacts.feature_collection, artifacts.files)
    session = manager.create_session(
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        feature_collection=feature_collection,
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
        files=artifacts.files,
        cleanup_summary=artifacts.cleanup_summary,
        warnings=artifacts.warnings,
    )
