"""Add further source data to a session that already holds an IMDF dataset.

Staging and committing are separate calls on purpose: the review screen's edits
are not recoverable, so the caller sees what a batch would do before it lands.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Query, Request, UploadFile

from backend.routers.import_router import _read_uploaded_blobs
from backend.src.append_importer import (
    AppendError,
    candidate_features,
    commit_append,
    discard_staged,
    load_replaced,
    load_staged,
    plan_append,
    promote_batch_artifacts,
    remove_batch_artifacts,
    restage_append,
    save_replaced,
    save_staged,
    stage_append,
    undo_append,
)
from backend.src.schemas import (
    AppendBatchSummary,
    AppendCandidateFeaturesResponse,
    AppendCommitRequest,
    AppendCommitResponse,
    AppendRestageRequest,
    AppendStageResponse,
    AppendUndoResponse,
)
from backend.src.session import SessionManager


router = APIRouter(prefix="/api/session/{session_id}", tags=["append"])


def _session_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager


def _uploads_root(request: Request) -> Path:
    path = getattr(request.app.state, "session_uploads_dir", Path("./data/session_uploads"))
    directory = Path(path)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _get_session(session_id: str, request: Request):
    session = _session_manager(request).get_session(session_id=session_id)
    if session is None:
        raise KeyError("Session not found")
    return session


@router.post("/import/stage", response_model=AppendStageResponse, status_code=201)
async def stage_session_import(
    session_id: str,
    request: Request,
    files: Annotated[list[UploadFile], File(description="Shapefile components, a zip of them, or an IMDF .zip")],
    profile: Annotated[str, Query()] = "imdf_shapefile",
    prefer_filename_floor: Annotated[bool, Query()] = False,
) -> AppendStageResponse:
    session = _get_session(session_id, request)
    raw_blobs = await _read_uploaded_blobs(request, files)
    _, plan = stage_append(
        session,
        raw_blobs,
        profile=profile,
        uploads_root=_uploads_root(request),
        filename_keywords_path=request.app.state.filename_keywords_path,
        unit_categories_path=request.app.state.unit_categories_path,
        prefer_filename_floor=prefer_filename_floor,
    )
    return plan


@router.get("/import/stage/{batch_id}", response_model=AppendStageResponse)
def get_staged_import(session_id: str, batch_id: str, request: Request) -> AppendStageResponse:
    session = _get_session(session_id, request)
    staged = load_staged(_uploads_root(request), session_id, batch_id)
    return plan_append(session, staged)


@router.patch("/import/stage/{batch_id}", response_model=AppendStageResponse)
def restage_session_import(
    session_id: str,
    batch_id: str,
    payload: AppendRestageRequest,
    request: Request,
) -> AppendStageResponse:
    """Re-map a staged batch without re-uploading it."""
    session = _get_session(session_id, request)
    uploads_root = _uploads_root(request)
    staged = load_staged(uploads_root, session_id, batch_id)
    staged, plan = restage_append(
        session,
        staged,
        files=payload.files,
        mappings=payload.mappings,
        unit_categories_path=request.app.state.unit_categories_path,
    )
    save_staged(uploads_root, staged)
    return plan


@router.get("/import/stage/{batch_id}/features", response_model=AppendCandidateFeaturesResponse)
def get_staged_features(session_id: str, batch_id: str, request: Request) -> AppendCandidateFeaturesResponse:
    """The batch's features, flattened so the caller can choose among them.

    The selection sent back at commit is declarative and re-evaluated there, so
    what this draws is a preview and never what decides.
    """
    session = _get_session(session_id, request)
    staged = load_staged(_uploads_root(request), session_id, batch_id)
    return candidate_features(session, staged)


@router.delete("/import/stage/{batch_id}", status_code=204)
def discard_staged_import(session_id: str, batch_id: str, request: Request) -> None:
    _get_session(session_id, request)
    discard_staged(_uploads_root(request), session_id, batch_id)


@router.post("/import/commit", response_model=AppendCommitResponse)
def commit_session_import(
    session_id: str,
    payload: AppendCommitRequest,
    request: Request,
) -> AppendCommitResponse:
    manager = _session_manager(request)
    session = _get_session(session_id, request)
    uploads_root = _uploads_root(request)
    # Checked before the staged copy is read, because a committed batch no
    # longer has one and "not found" would be a poor answer to "already added".
    if any(item.batch_id == payload.batch_id for item in session.append_batches):
        raise AppendError("This import has already been added to the session.")

    staged = load_staged(uploads_root, session_id, payload.batch_id)
    if staged.session_id != session_id:
        raise AppendError("This staged import belongs to a different session.")

    result, replaced = commit_append(
        session,
        staged,
        decisions=payload.level_decisions,
        on_id_collision=payload.on_id_collision,
        selection=payload.selection,
        apply_alignment=payload.apply_alignment,
        expand_levels=payload.expand_levels,
    )
    session.upload_artifact_dir = promote_batch_artifacts(uploads_root, session, payload.batch_id)
    save_replaced(uploads_root, session_id, payload.batch_id, replaced)
    # The staged copy holds the whole batch a second time; only what undo needs
    # outlives the commit.
    discard_staged(uploads_root, session_id, payload.batch_id)
    manager.save_session(session)
    return result


@router.get("/import/batches", response_model=list[AppendBatchSummary])
def list_import_batches(session_id: str, request: Request) -> list[AppendBatchSummary]:
    return _get_session(session_id, request).append_batches


@router.delete("/import/batches/{batch_id}", response_model=AppendUndoResponse)
def undo_import_batch(session_id: str, batch_id: str, request: Request) -> AppendUndoResponse:
    manager = _session_manager(request)
    session = _get_session(session_id, request)
    uploads_root = _uploads_root(request)

    summary = next((item for item in session.append_batches if item.batch_id == batch_id), None)
    stems = list(summary.file_stems) if summary else []
    result = undo_append(
        session,
        batch_id,
        replaced_features=load_replaced(uploads_root, session_id, batch_id),
    )
    remove_batch_artifacts(session, stems)
    discard_staged(uploads_root, session_id, batch_id)
    manager.save_session(session)
    return result
