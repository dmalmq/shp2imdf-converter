"""Station colour theme: a standalone tool beside the shapefile wizard and the Illustrator flow.

Stateless on purpose. The browser keeps the station's files and sends them
once to inspect and once to convert; nothing is held between the calls, and
no session, project or wizard state is touched. Off the /api/session prefix,
so SessionLockMiddleware never sees these requests.

The one exception is a vector tile build (``vector_tiles=true``): it outlasts
the request, so convert answers 202 with a job id, the page polls the job and
downloads it when done, and ``TileJobs`` prunes finished jobs.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import zipfile

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from backend.routers.common import attachment_response, max_upload_bytes, read_uploads
from backend.src.arcgis_pro import ArcpyAvailable, ArcpyChecking, ArcpyProbe, ArcpyStatus
from backend.src.color_theme import ColorTheme, ThemeReport, plan
from backend.src.errors import ApiError, NotFoundError
from backend.src.recolor import Archive, Inspection, convert, inspect, is_project
from backend.src.tile_jobs import JobStatus, TileJobs

router = APIRouter(prefix="/api/color-theme", tags=["color-theme"])

# A station folder runs to about 500 files, each sent with its path, which is
# already half of Starlette's default 1,000 files and 1,000 fields.
_FORM_PARTS = 20_000


def _theme(request: Request) -> ColorTheme:
    return request.app.state.color_theme


def _gdal_python(request: Request) -> Path | None:
    """Resolved once at startup by ``find_gdal_python``."""
    return request.app.state.gdal_python


@dataclass(frozen=True, slots=True)
class _Station:
    blobs: list[tuple[str, bytes]]
    style_files: bool
    """The ``style_files`` part: ``true`` to add style files to the download. Left out, none are added."""
    vector_tiles: bool
    """The ``vector_tiles`` part: ``true`` to build vector tiles from the upload's one project, as a job."""


_FLAGS = {"true": True, "false": False}


async def _station(request: Request) -> _Station:
    """``files`` parts with a ``paths`` part each, in the same order; paths may be left out for bare names."""
    async with request.form(max_files=_FORM_PARTS, max_fields=_FORM_PARTS) as form:
        files = form.getlist("files")
        paths = form.getlist("paths")
        if not all(isinstance(item, UploadFile) for item in files) or not all(isinstance(item, str) for item in paths):
            raise ValueError("Send each file as a 'files' file part and its path as a 'paths' text part.")
        flags = {name: form.get(name, "false") for name in ("style_files", "vector_tiles")}
        for name, flag in flags.items():
            if flag not in _FLAGS:
                raise ValueError(f"{name} must be 'true' or 'false'.")
        return _Station(
            blobs=await read_uploads(request, files, names=paths or None),
            style_files=_FLAGS[flags["style_files"]],
            vector_tiles=_FLAGS[flags["vector_tiles"]],
        )


@router.get("", response_model=ThemeReport)
def color_theme(request: Request) -> ThemeReport:
    """The whole old-to-new table with every count at zero, for the page to show before an upload."""
    return plan(_theme(request), []).report


@router.post("/inspect", response_model=Inspection)
async def inspect_color_theme(request: Request) -> Inspection:
    station = await _station(request)
    return await run_in_threadpool(
        inspect, _theme(request), station.blobs, max_bytes=max_upload_bytes(request), gdal_python=_gdal_python(request)
    )


def _arcpy(request: Request) -> ArcpyStatus:
    probe: ArcpyProbe = request.app.state.arcpy
    return probe.status


def _tile_jobs(request: Request) -> TileJobs:
    return request.app.state.tile_jobs


@router.get("/vector-tiles", response_model=ArcpyStatus)
def vector_tiles(request: Request) -> ArcpyStatus:
    """Whether this server can build vector tiles; ``checking`` for the first seconds after startup."""
    return _arcpy(request)


@router.post("/convert")
async def convert_color_theme(request: Request) -> Response:
    """The converted zip; with ``vector_tiles=true``, 202 and the id of the job that builds it."""
    station = await _station(request)
    arcpy = _arcpy(request)
    if station.vector_tiles and not isinstance(arcpy, ArcpyAvailable):
        detail = "still being checked" if isinstance(arcpy, ArcpyChecking) else arcpy.detail
        raise ApiError(f"Vector tiles cannot be built on this server: {detail}", "VECTOR_TILES_UNAVAILABLE", 409)
    archive = await run_in_threadpool(
        convert,
        _theme(request),
        station.blobs,
        max_bytes=max_upload_bytes(request),
        gdal_python=_gdal_python(request),
        style_files=station.style_files,
    )
    if not station.vector_tiles:
        return attachment_response(archive.data, archive.filename)
    project = _one_project(archive)
    job_id = await run_in_threadpool(_tile_jobs(request).submit, archive, project, arcpy.python)
    return JSONResponse(status_code=202, content={"job_id": job_id})


def _one_project(archive: Archive) -> str:
    with zipfile.ZipFile(BytesIO(archive.data)) as converted:
        projects = [name for name in converted.namelist() if not name.endswith("/") and is_project(name)]
    if len(projects) != 1:
        raise ApiError(
            f"Vector tiles are built from one ArcGIS Pro project (.aprx); this upload has {len(projects)}.",
            "VECTOR_TILES_NEED_ONE_PROJECT",
            400,
        )
    return projects[0]


def _job_not_found() -> NotFoundError:
    return NotFoundError(
        "This vector tile build is not on the server. It may have been removed after a restart or once it expired.",
        "TILE_JOB_NOT_FOUND",
    )


@router.get("/jobs/{job_id}", response_model=JobStatus)
def tile_job(job_id: str, request: Request) -> JobStatus:
    status = _tile_jobs(request).status(job_id)
    if status is None:
        raise _job_not_found()
    return status


@router.get("/jobs/{job_id}/download")
def tile_job_download(job_id: str, request: Request) -> FileResponse:
    jobs = _tile_jobs(request)
    status = jobs.status(job_id)
    if status is None:
        raise _job_not_found()
    path = jobs.download(job_id)
    if path is None:
        raise ApiError("This vector tile build has not finished.", "TILE_JOB_NOT_DONE", 409)
    return FileResponse(path, media_type="application/zip", filename=status.filename)
