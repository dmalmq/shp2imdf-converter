"""The files each export format would download, without downloading anything.

Every listing comes from the archive the export itself builds, so the names
cannot drift from what the download holds. Nothing here saves the session or
records a delivery.
"""

from __future__ import annotations

from collections.abc import Callable
from io import BytesIO
import json
import zipfile

from backend.src.exporter import build_export_archive
from backend.src.qgis_export import QgisUnavailableError, _resolve_qgis_python
from backend.src.schemas import ExportContents, ExportContentsResponse, ExportFormat, SessionRecord, ShapefileExportRequest
from backend.src.shapefile_exporter import (
    _safe_export_name,
    build_odc2026_shapefile_export_archive,
    build_shapefile_export_archive,
    qgis_project_names,
)

REPORT_NAME = "export_report.json"


def _contents(export_format: ExportFormat, build: Callable[[], tuple[bytes, str]]) -> ExportContents:
    try:
        payload, filename = build()
    except (ValueError, QgisUnavailableError) as exc:
        return ExportContents(format=export_format, unavailable=str(exc))
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        entries = archive.namelist()
        report = json.loads(archive.read(REPORT_NAME)) if REPORT_NAME in entries else {}
    skipped = report.get("rows_skipped", []) if export_format == "odc2026_shapefiles" else []
    return ExportContents(format=export_format, filename=filename, entries=entries, rows_skipped=skipped)


def describe_exports(session: SessionRecord, export_name: str, encoding: str) -> ExportContentsResponse:
    odc_request = ShapefileExportRequest(profile="odc2026", encoding=encoding, export_name=export_name)
    outputs = [
        _contents("imdf", lambda: build_export_archive(session)),
        _contents("imdf_zip", lambda: build_export_archive(session, extension="zip")),
        _contents("shapefiles", lambda: build_shapefile_export_archive(session, ShapefileExportRequest(encoding=encoding))),
        _contents("odc2026_shapefiles", lambda: build_odc2026_shapefile_export_archive(session, odc_request)),
    ]
    odc = outputs[-1]
    if odc.unavailable is not None:
        qgis = ExportContents(format="qgis_project", unavailable=odc.unavailable)
    elif _resolve_qgis_python() is None:
        qgis = ExportContents(format="qgis_project", unavailable="QGIS is not installed on this workstation.")
    else:
        qgz, archive_name = qgis_project_names(_safe_export_name(export_name))
        entries = [name for name in odc.entries if name != REPORT_NAME] + [qgz, REPORT_NAME]
        qgis = ExportContents(format="qgis_project", filename=archive_name, entries=entries)
    return ExportContentsResponse(outputs=[*outputs, qgis])
