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
import json
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
from backend.src.tile_layers import (
    LayersUnreadable,
    NoMapLayers,
    SelectionError,
    TileExclusions,
    TilePlan,
    read_project_layers,
    tile_plan,
)

router = APIRouter(prefix="/api/color-theme", tags=["color-theme"])

# A station folder runs to about 500 files, each sent with its path, which is
# already half of Starlette's default 1,000 files and 1,000 fields.
_FORM_PARTS = 20_000


def _theme(request: Request) -> ColorTheme:
    return request.app.state.color_theme


def _exclusions(request: Request) -> TileExclusions:
    return request.app.state.tile_exclusions


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
    tile_map: str | None
    """The ``tile_map`` part: the id of the map to tile. Left out, the project's default map."""
    tile_layers: frozenset[str] | None
    """The ``tile_layers`` part: a JSON list of the uRIs of every layer to tile. Left out, the map's defaults."""


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
        tile_map = form.get("tile_map")
        if tile_map is not None and (not isinstance(tile_map, str) or not tile_map):
            raise ValueError("tile_map must be a map id.")
        tile_layers = _tile_layers(form.get("tile_layers"))
        for name, part in (("tile_map", tile_map), ("tile_layers", tile_layers)):
            if part is not None and not _FLAGS[flags["vector_tiles"]]:
                raise ValueError(f"{name} is only sent with vector_tiles=true.")
        return _Station(
            blobs=await read_uploads(request, files, names=paths or None),
            style_files=_FLAGS[flags["style_files"]],
            vector_tiles=_FLAGS[flags["vector_tiles"]],
            tile_map=tile_map,
            tile_layers=tile_layers,
        )


def _tile_layers(part: object) -> frozenset[str] | None:
    if part is None:
        return None
    try:
        uris = json.loads(part) if isinstance(part, str) else None
    except ValueError:
        uris = None
    if not isinstance(uris, list) or not all(isinstance(uri, str) for uri in uris):
        raise ValueError("tile_layers must be a JSON list of layer uRIs.")
    return frozenset(uris)


@router.get("", response_model=ThemeReport)
def color_theme(request: Request) -> ThemeReport:
    """The whole old-to-new table with every count at zero, for the page to show before an upload."""
    return plan(_theme(request), []).report


@router.post("/inspect", response_model=Inspection)
async def inspect_color_theme(request: Request) -> Inspection:
    station = await _station(request)
    return await run_in_threadpool(
        inspect,
        _theme(request),
        station.blobs,
        max_bytes=max_upload_bytes(request),
        gdal_python=_gdal_python(request),
        exclusions=_exclusions(request),
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
    project, data = _one_project(archive)
    tiles = await run_in_threadpool(
        _tile_plan, data, station.tile_map, station.tile_layers, _exclusions(request), max_bytes=max_upload_bytes(request)
    )
    job_id = await run_in_threadpool(_tile_jobs(request).submit, archive, project, arcpy.python, tiles)
    return JSONResponse(status_code=202, content={"job_id": job_id})


def _one_project(archive: Archive) -> tuple[str, bytes]:
    with zipfile.ZipFile(BytesIO(archive.data)) as converted:
        projects = [name for name in converted.namelist() if not name.endswith("/") and is_project(name)]
        if len(projects) != 1:
            raise ApiError(
                f"Vector tiles are built from one ArcGIS Pro project (.aprx); this upload has {len(projects)}.",
                "VECTOR_TILES_NEED_ONE_PROJECT",
                400,
            )
        return projects[0], converted.read(projects[0])


_SELECTION_CODES = {
    "unknown_map": "VECTOR_TILES_UNKNOWN_MAP",
    "empty_map": "VECTOR_TILES_EMPTY_MAP",
    "layers": "VECTOR_TILES_BAD_LAYERS",
}


def _tile_plan(
    project: bytes, map_id: str | None, chosen: frozenset[str] | None, exclusions: TileExclusions, *, max_bytes: int
) -> TilePlan:
    """The map and visibility to tile with: the operator's choice, or with none sent, the project's defaults."""
    maps = read_project_layers(project, exclusions, max_bytes=max_bytes)
    if isinstance(maps, NoMapLayers):
        names = ", ".join(maps.maps) or "none"
        raise ApiError(
            f"No map in the project has a layer to tile. Its maps: {names}.", "VECTOR_TILES_NO_MAP_LAYERS", 400
        )
    if isinstance(maps, LayersUnreadable):
        raise ApiError(f"The project's layers could not be read: {maps.detail}", "VECTOR_TILES_PROJECT_UNREADABLE", 400)
    try:
        return tile_plan(maps, map_id, chosen)
    except SelectionError as exc:
        raise ApiError(str(exc), _SELECTION_CODES[exc.kind], 400) from exc


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
