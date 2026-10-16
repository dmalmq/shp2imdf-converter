"""Split a brought-in import into one project per building."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from backend.routers.common import get_session_or_raise, session_manager, session_uploads_dir
from backend.src.schemas import SplitPreviewResponse, SplitProject, SplitRequest, SplitResponse
from backend.src.split import preview_split, source_collection, split_session

router = APIRouter(prefix="/api/session/{session_id}", tags=["split"])


@router.get("/split/features")
def features(session_id: str, request: Request) -> dict[str, Any]:
    """The features a split assigns, for the split map to draw.

    Once Set up has run, `/features` is the generated set, which a split never sees.
    """
    return source_collection(get_session_or_raise(session_id, request))


@router.post("/split/preview", response_model=SplitPreviewResponse)
def preview(session_id: str, payload: SplitRequest, request: Request) -> SplitPreviewResponse:
    return preview_split(source_collection(get_session_or_raise(session_id, request)), payload.shapes)


@router.post("/split", response_model=SplitResponse, status_code=201)
async def split(session_id: str, payload: SplitRequest, request: Request) -> SplitResponse:
    return await run_in_threadpool(_split, session_id, payload, request)


def _split(session_id: str, payload: SplitRequest, request: Request) -> SplitResponse:
    parent = get_session_or_raise(session_id, request)
    children, unassigned_total = split_session(
        session_manager(request), parent, payload.shapes, session_uploads_dir(request)
    )
    return SplitResponse(
        projects=[
            SplitProject(
                session_id=child.session_id,
                name=child.split_from.name if child.split_from else "",
                feature_count=len((child.source_feature_collection or {}).get("features") or []),
            )
            for child in children
        ],
        unassigned_total=unassigned_total,
    )
