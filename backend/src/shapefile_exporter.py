"""Shapefile round-trip export helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
import json
from pathlib import Path
import re
import tempfile
from typing import Any
import zipfile

import geopandas as gpd

from backend.src.schemas import SessionRecord, ShapefileExportRequest


SUPPORTED_SHAPEFILE_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix"}
REQUIRED_SHAPEFILE_EXTENSIONS = {".shp", ".shx", ".dbf"}


@dataclass(slots=True)
class RowUpdate:
    categories: set[str] = field(default_factory=set)
    feature_ids: set[str] = field(default_factory=set)


def _safe_export_name(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return normalized.strip("._-") or "shapefile_export"


def _normalize_shapefile_field_name(value: str, fallback: str) -> str:
    candidate = value.strip() if value.strip() else fallback
    candidate = re.sub(r"[^A-Za-z0-9_]+", "_", candidate)
    candidate = candidate.strip("_") or fallback
    return candidate[:10]


def _encoding_for_write(requested: str) -> str | None:
    if requested == "utf-8":
        return "UTF-8"
    if requested == "cp932":
        return "CP932"
    return None


def _parse_source_feature_ref(value: Any) -> tuple[str, int, int] | None:
    if not isinstance(value, str):
        return None
    parts = value.rsplit(":", 2)
    if len(parts) != 3:
        return None
    stem = parts[0].strip()
    if not stem:
        return None
    try:
        row_index = int(parts[1])
        part_index = int(parts[2])
    except ValueError:
        return None
    if row_index < 0 or part_index < 0:
        return None
    return stem, row_index, part_index


def _collect_unit_row_updates(
    feature_collection: dict[str, Any],
) -> tuple[dict[tuple[str, int], RowUpdate], list[dict[str, str]]]:
    updates: dict[tuple[str, int], RowUpdate] = {}
    unapplied: list[dict[str, str]] = []
    rows = feature_collection.get("features", [])
    if not isinstance(rows, list):
        return updates, unapplied

    for feature in rows:
        if not isinstance(feature, dict):
            continue
        if feature.get("feature_type") != "unit":
            continue

        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue

        category_value = properties.get("category")
        if not isinstance(category_value, str):
            continue
        category = category_value.strip().lower()
        if not category:
            continue

        stem_value = properties.get("source_file")
        row_index_value = properties.get("source_row_index")
        stem: str | None = stem_value.strip() if isinstance(stem_value, str) and stem_value.strip() else None
        row_index: int | None = row_index_value if isinstance(row_index_value, int) else None

        if stem is None or row_index is None:
            parsed_ref = _parse_source_feature_ref(properties.get("source_feature_ref"))
            if parsed_ref is not None:
                stem = parsed_ref[0]
                row_index = parsed_ref[1]

        feature_id = str(feature.get("id")) if feature.get("id") is not None else ""
        if stem is None or row_index is None:
            unapplied.append(
                {
                    "feature_id": feature_id,
                    "reason": "missing_source_linkage",
                }
            )
            continue

        key = (stem, row_index)
        update = updates.setdefault(key, RowUpdate())
        update.categories.add(category)
        if feature_id:
            update.feature_ids.add(feature_id)

    return updates, unapplied


def _group_artifact_files(upload_artifact_dir: Path) -> dict[str, dict[str, Path]]:
    grouped: dict[str, dict[str, Path]] = {}
    for entry in upload_artifact_dir.iterdir():
        if not entry.is_file():
            continue
        suffix = entry.suffix.lower()
        if suffix not in SUPPORTED_SHAPEFILE_EXTENSIONS:
            continue
        grouped.setdefault(entry.stem, {})[suffix] = entry
    return grouped


def _build_export_report(request: ShapefileExportRequest) -> dict[str, Any]:
    return {
        "mode": request.mode,
        "encoding": request.encoding,
        "legacy_code_map_source": "none",
        "legacy_code_conflicts": [],
        "rows_requested": 0,
        "rows_updated": 0,
        "stems_processed": [],
        "conflicts": [],
        "skipped": [],
        "unapplied_features": [],
    }


def _normalize_legacy_code_map(raw_map: dict[str, str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for raw_category, raw_code in raw_map.items():
        category = str(raw_category).strip().lower()
        code = str(raw_code).strip()
        if not category or not code:
            continue
        normalized[category] = code
    return normalized


def _derive_legacy_code_map_from_wizard(
    company_mappings: dict[str, str],
) -> tuple[dict[str, str], list[dict[str, str]]]:
    derived: dict[str, str] = {}
    conflicts: list[dict[str, str]] = []

    for raw_code, raw_category in sorted(
        company_mappings.items(),
        key=lambda item: str(item[0]).upper(),
    ):
        code = str(raw_code).strip()
        category = str(raw_category).strip().lower()
        if not code or not category:
            continue
        existing = derived.get(category)
        if existing is None:
            derived[category] = code
            continue
        if existing == code:
            continue
        conflicts.append(
            {
                "category": category,
                "selected_code": existing,
                "ignored_code": code,
                "reason": "duplicate_category_mapping",
            }
        )
    return derived, conflicts


def _resolve_legacy_code_map(
    payload_map: dict[str, str],
    wizard_company_mappings: dict[str, str],
) -> tuple[dict[str, str], str, list[dict[str, str]]]:
    normalized_payload = _normalize_legacy_code_map(payload_map)
    if normalized_payload:
        return normalized_payload, "payload", []

    derived, conflicts = _derive_legacy_code_map_from_wizard(wizard_company_mappings)
    if derived:
        return derived, "wizard_company_mappings", conflicts
    return {}, "none", conflicts


def build_shapefile_export_archive(
    session: SessionRecord,
    request: ShapefileExportRequest,
) -> tuple[bytes, str]:
    upload_artifact_dir = Path(session.upload_artifact_dir or "")
    if not session.upload_artifact_dir or not upload_artifact_dir.exists():
        raise ValueError("Shapefile export unavailable: uploaded source files are not available for this session.")

    grouped_files = _group_artifact_files(upload_artifact_dir)
    shapefile_groups = {
        stem: components
        for stem, components in grouped_files.items()
        if REQUIRED_SHAPEFILE_EXTENSIONS.issubset(components.keys())
    }
    if not shapefile_groups:
        raise ValueError("Shapefile export unavailable: no complete source shapefile groups found.")

    updates_by_row, unapplied_features = _collect_unit_row_updates(session.feature_collection)
    report = _build_export_report(request)
    report["rows_requested"] = len(updates_by_row)
    report["unapplied_features"] = unapplied_features

    unit_options = request.unit
    imdf_field = _normalize_shapefile_field_name(unit_options.imdf_category_field, "IMDF_CAT")
    legacy_field = (
        _normalize_shapefile_field_name(unit_options.overwrite_legacy_code_field, "LEGACY_CD")
        if unit_options.overwrite_legacy_code_field
        else None
    )
    legacy_map, legacy_map_source, legacy_map_conflicts = _resolve_legacy_code_map(
        unit_options.legacy_code_map,
        session.wizard.company_mappings,
    )
    report["legacy_code_map_source"] = legacy_map_source
    report["legacy_code_conflicts"] = legacy_map_conflicts

    handled_update_keys: set[tuple[str, int]] = set()
    write_encoding = _encoding_for_write(request.encoding)

    with tempfile.TemporaryDirectory() as tmpdir:
        output_dir = Path(tmpdir)

        for stem, components in sorted(shapefile_groups.items()):
            shapefile_path = components[".shp"]
            gdf = gpd.read_file(shapefile_path)
            stem_update_count = 0

            stem_updates = {
                key: update for key, update in updates_by_row.items() if key[0] == stem
            }
            for key, update in stem_updates.items():
                _, row_index = key
                if row_index < 0 or row_index >= len(gdf):
                    report["skipped"].append(
                        {
                            "stem": stem,
                            "row_index": row_index,
                            "reason": "row_index_out_of_range",
                        }
                    )
                    handled_update_keys.add(key)
                    continue

                if len(update.categories) != 1:
                    report["conflicts"].append(
                        {
                            "stem": stem,
                            "row_index": row_index,
                            "reason": "conflicting_categories",
                            "categories": sorted(update.categories),
                            "feature_ids": sorted(update.feature_ids),
                        }
                    )
                    handled_update_keys.add(key)
                    continue

                category = next(iter(update.categories))
                row_label = gdf.index[row_index]
                row_updated = False

                if unit_options.write_imdf_category:
                    gdf.loc[row_label, imdf_field] = category
                    row_updated = True

                if legacy_field is not None:
                    mapped_legacy_code = legacy_map.get(category)
                    if mapped_legacy_code is None:
                        report["skipped"].append(
                            {
                                "stem": stem,
                                "row_index": row_index,
                                "reason": "legacy_code_mapping_missing",
                                "category": category,
                            }
                        )
                    else:
                        gdf.loc[row_label, legacy_field] = mapped_legacy_code
                        row_updated = True

                if row_updated:
                    stem_update_count += 1
                    report["rows_updated"] += 1
                else:
                    report["skipped"].append(
                        {
                            "stem": stem,
                            "row_index": row_index,
                            "reason": "no_writable_fields_configured",
                        }
                    )

                handled_update_keys.add(key)

            destination = output_dir / f"{stem}.shp"
            write_kwargs: dict[str, Any] = {"driver": "ESRI Shapefile", "index": False}
            if write_encoding is not None:
                write_kwargs["encoding"] = write_encoding
            gdf.to_file(destination, **write_kwargs)
            report["stems_processed"].append(
                {
                    "stem": stem,
                    "rows_total": int(len(gdf)),
                    "rows_updated": stem_update_count,
                }
            )

        for (stem, row_index), _ in updates_by_row.items():
            key = (stem, row_index)
            if key in handled_update_keys:
                continue
            report["skipped"].append(
                {
                    "stem": stem,
                    "row_index": row_index,
                    "reason": "source_stem_not_found",
                }
            )

        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for exported_file in sorted(output_dir.glob("*")):
                if exported_file.is_file():
                    archive.write(exported_file, arcname=exported_file.name)
            if request.include_report:
                archive.writestr("export_report.json", json.dumps(report, ensure_ascii=False, indent=2))

    project_name = session.wizard.project.project_name if session.wizard.project else None
    fallback = project_name or session.wizard.project.venue_name if session.wizard.project else session.session_id
    filename = f"{_safe_export_name(fallback)}_shapefiles.zip"
    return archive_bytes.getvalue(), filename
