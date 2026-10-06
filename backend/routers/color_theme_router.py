"""Station colour theme: a standalone tool beside the shapefile wizard and the Illustrator flow.

Stateless on purpose. The browser keeps the station's files and sends them
once to inspect and once to convert; nothing is held between the calls, so
nothing expires and nothing needs pruning, and no session, project or wizard
state is touched. Off the /api/session prefix, so SessionLockMiddleware never
sees these requests.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from backend.routers.common import attachment_response, max_upload_bytes, read_uploads
from backend.src.color_theme import ColorTheme, ThemeReport, plan
from backend.src.recolor import Inspection, convert, inspect

router = APIRouter(prefix="/api/color-theme", tags=["color-theme"])

# A station folder runs to about 500 files, each sent with its path, which is
# already half of Starlette's default 1,000 files and 1,000 fields.
_FORM_PARTS = 20_000


def _theme(request: Request) -> ColorTheme:
    return request.app.state.color_theme


def _gdal_python(request: Request) -> Path | None:
    """Resolved once at startup by ``find_gdal_python``."""
    return request.app.state.gdal_python


async def _station(request: Request) -> list[tuple[str, bytes]]:
    """``files`` parts with a ``paths`` part each, in the same order; paths may be left out for bare names."""
    async with request.form(max_files=_FORM_PARTS, max_fields=_FORM_PARTS) as form:
        files = form.getlist("files")
        paths = form.getlist("paths")
        if not all(isinstance(item, UploadFile) for item in files) or not all(isinstance(item, str) for item in paths):
            raise ValueError("Send each file as a 'files' file part and its path as a 'paths' text part.")
        return await read_uploads(request, files, names=paths or None)


@router.get("", response_model=ThemeReport)
def color_theme(request: Request) -> ThemeReport:
    """The whole old-to-new table with every count at zero, for the page to show before an upload."""
    return plan(_theme(request), []).report


@router.post("/inspect", response_model=Inspection)
async def inspect_color_theme(request: Request) -> Inspection:
    blobs = await _station(request)
    return await run_in_threadpool(
        inspect, _theme(request), blobs, max_bytes=max_upload_bytes(request), gdal_python=_gdal_python(request)
    )


@router.post("/convert")
async def convert_color_theme(request: Request) -> Response:
    blobs = await _station(request)
    archive = await run_in_threadpool(
        convert, _theme(request), blobs, max_bytes=max_upload_bytes(request), gdal_python=_gdal_python(request)
    )
    return attachment_response(archive.data, archive.filename)
