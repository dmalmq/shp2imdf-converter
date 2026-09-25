"""The files each export format would download, without downloading anything.

Every listing comes from the archive the export itself builds, so the names
cannot drift from what the download holds: ODC's per-floor files depend on
floor tokens, levels sharing a floor, geometry filters and skipped empty
layers, and a second copy of those rules would. Nothing here saves the
session or records a delivery. Listings are cached per content revision, so
only the first look at a revision pays for the build.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from io import BytesIO
import json
import logging
from threading import Lock
import zipfile

from backend.src.exporter import build_export_archive, export_archive_name
from backend.src.qgis_export import QgisUnavailableError, _resolve_qgis_python
from backend.src.schemas import (
    ExportContents,
    ExportContentsResponse,
    ExportFormat,
    ExportUnavailable,
    SessionRecord,
    ShapefileExportRequest,
)
from backend.src.shapefile_exporter import (
    _safe_export_name,
    build_odc2026_shapefile_export_archive,
    build_shapefile_export_archive,
    qgis_project_names,
)

logger = logging.getLogger(__name__)

REPORT_NAME = "export_report.json"
_CACHE_SIZE = 16
_cache: OrderedDict[tuple[str, int, str, str], list[ExportContents]] = OrderedDict()
_cache_lock = Lock()

# The exporters raise ValueError with these phrases for the reasons an operator can act on.
_REASONS: tuple[tuple[str, ExportUnavailable], ...] = (
    ("GeoPackage", "geopackage"),
    ("file name prefix", "no_prefix"),
    ("source files are not available", "no_sources"),
    ("no complete source shapefile groups", "no_sources"),
)


def _reason(exc: Exception) -> ExportUnavailable:
    if isinstance(exc, QgisUnavailableError):
        return "qgis_missing"
    if isinstance(exc, ValueError):
        text = str(exc)
        return next((reason for phrase, reason in _REASONS if phrase in text), "failed")
    return "failed"


def _listing(export_format: ExportFormat, build: Callable[[], tuple[bytes, str]]) -> ExportContents:
    try:
        payload, filename = build()
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            entries = archive.namelist()
            report = json.loads(archive.read(REPORT_NAME)) if REPORT_NAME in entries else {}
    except Exception as exc:  # one format failing to list must not take the others with it
        if not isinstance(exc, (ValueError, QgisUnavailableError)):
            logger.exception("Could not list the %s export", export_format)
        return ExportContents(format=export_format, unavailable=str(exc), reason=_reason(exc))
    skipped = report.get("rows_skipped", []) if export_format == "odc2026_shapefiles" else []
    return ExportContents(format=export_format, filename=filename, entries=entries, rows_skipped=skipped)


def _build_listings(session: SessionRecord, export_name: str, encoding: str) -> list[ExportContents]:
    imdf = _listing("imdf", lambda: build_export_archive(session))
    # The .zip is the same archive under another name.
    imdf_zip = imdf.model_copy(
        update={"format": "imdf_zip", "filename": export_archive_name(session, "zip") if imdf.filename else None}
    )
    odc_request = ShapefileExportRequest(profile="odc2026", encoding=encoding, export_name=export_name)
    shapefiles = _listing(
        "shapefiles", lambda: build_shapefile_export_archive(session, ShapefileExportRequest(encoding=encoding))
    )
    odc = _listing("odc2026_shapefiles", lambda: build_odc2026_shapefile_export_archive(session, odc_request))
    return [imdf, imdf_zip, shapefiles, odc]


def _qgis(odc: ExportContents, export_name: str) -> ExportContents:
    if odc.reason is not None:
        return ExportContents(format="qgis_project", unavailable=odc.unavailable, reason=odc.reason)
    if _resolve_qgis_python() is None:
        return ExportContents(
            format="qgis_project", unavailable="QGIS is not installed on this workstation.", reason="qgis_missing"
        )
    qgz, archive_name = qgis_project_names(_safe_export_name(export_name))
    entries = [name for name in odc.entries if name != REPORT_NAME] + [qgz, REPORT_NAME]
    return ExportContents(format="qgis_project", filename=archive_name, entries=entries)


def describe_exports(session: SessionRecord, export_name: str, encoding: str) -> ExportContentsResponse:
    key = (session.session_id, session.content_rev, export_name, encoding)
    with _cache_lock:
        listings = _cache.get(key)
        if listings is not None:
            _cache.move_to_end(key)
    if listings is None:
        listings = _build_listings(session, export_name, encoding)
        with _cache_lock:
            _cache[key] = listings
            while len(_cache) > _CACHE_SIZE:
                _cache.popitem(last=False)
    # QGIS availability is a property of this PC, not of the project, so it is asked every time.
    return ExportContentsResponse(outputs=[*listings, _qgis(listings[-1], export_name)])
