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
import pandas as pd

from backend.src.schemas import SessionRecord, ShapefileExportRequest


SUPPORTED_SHAPEFILE_EXTENSIONS = {".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix"}
REQUIRED_SHAPEFILE_EXTENSIONS = {".shp", ".shx", ".dbf"}
UNIT_EXPORT_COLUMNS = (
    "id",
    "category",
    "restrict",
    "name",
    "alt_name",
    "level_id",
    "source",
    "display_po",
)
OPENING_EXPORT_COLUMNS = (
    "id",
    "name",
    "source",
    "category",
    "access_con",
    "door",
    "alt_name",
    "level_id",
    "display_po",
)
FIXTURE_EXPORT_COLUMNS = (
    "id",
    "category",
    "source",
    "name",
    "alt_name",
    "level_id",
    "display_po",
)
DETAIL_EXPORT_COLUMNS = (
    "id",
    "level_id",
    "category",
    "source",
)
LEVEL_EXPORT_COLUMNS = (
    "id",
    "name",
    "source",
    "restrict",
    "display_po",
    "short_name",
    "outdoor",
    "ordinal",
    "address_id",
)


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


def _detected_type_by_stem(session: SessionRecord) -> dict[str, str]:
    return {
        item.stem: (item.detected_type or "").strip().lower()
        for item in session.files
        if item.stem
    }


def _replace_suffix(stem: str, pattern: str, replacement: str) -> str:
    if re.search(pattern, stem, flags=re.IGNORECASE):
        return re.sub(pattern, replacement, stem, flags=re.IGNORECASE)
    return stem


def _normalized_output_stem(stem: str, detected_type: str) -> str:
    if re.search(r"(drawing|detail)$", stem, flags=re.IGNORECASE):
        return re.sub(r"(drawing|detail)$", "detail", stem, flags=re.IGNORECASE)
    if re.search(r"(floor|level)$", stem, flags=re.IGNORECASE):
        return re.sub(r"(floor|level)$", "level", stem, flags=re.IGNORECASE)
    if re.search(r"opening$", stem, flags=re.IGNORECASE):
        return re.sub(r"opening$", "opening", stem, flags=re.IGNORECASE)
    if re.search(r"fixture$", stem, flags=re.IGNORECASE):
        return re.sub(r"fixture$", "fixture", stem, flags=re.IGNORECASE)
    if detected_type == "unit":
        return _replace_suffix(stem, r"space$", "unit")
    return stem


def _inferred_type_from_stem_suffix(stem: str) -> str:
    lower = stem.lower()
    if lower.endswith("space"):
        return "unit"
    if lower.endswith("opening"):
        return "opening"
    if lower.endswith("fixture"):
        return "fixture"
    if lower.endswith("drawing") or lower.endswith("detail"):
        return "detail"
    if lower.endswith("floor") or lower.endswith("level"):
        return "level"
    return ""


def _resolved_export_feature_type(stem: str, detected_type: str) -> str:
    suffix_type = _inferred_type_from_stem_suffix(stem)
    if suffix_type in {"opening", "fixture", "detail", "level"}:
        return suffix_type
    if detected_type:
        return detected_type
    return suffix_type


def _make_unique_stem(stem: str, used_lower: set[str]) -> str:
    candidate = stem
    suffix = 2
    while candidate.lower() in used_lower:
        candidate = f"{stem}_{suffix}"
        suffix += 1
    used_lower.add(candidate.lower())
    return candidate


def _build_column_lookup(columns: list[str]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for column in columns:
        key = column.strip().lower()
        if key and key not in lookup:
            lookup[key] = column
    return lookup


def _find_column_name(lookup: dict[str, str], candidates: list[str]) -> str | None:
    for candidate in candidates:
        name = lookup.get(candidate.strip().lower())
        if name:
            return name
    return None


def _series_or_empty(gdf: gpd.GeoDataFrame, column_name: str | None) -> pd.Series:
    if column_name is None:
        return pd.Series([None] * len(gdf), index=gdf.index, dtype="object")
    return gdf[column_name].astype("object")


def _constant_series(gdf: gpd.GeoDataFrame, value: Any) -> pd.Series:
    return pd.Series([value] * len(gdf), index=gdf.index, dtype="object")


def _coerce_to_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if pd.isna(value):
            return None
        return bool(int(value))
    if isinstance(value, str):
        lowered = value.strip().lower()
        if not lowered:
            return None
        if lowered in {"1", "true", "t", "yes", "y"}:
            return True
        if lowered in {"0", "false", "f", "no", "n"}:
            return False
    return None


def _bool_series_or_default(gdf: gpd.GeoDataFrame, column_name: str | None, default_value: bool = False) -> pd.Series:
    if column_name is None:
        return _constant_series(gdf, default_value)
    values = [_coerce_to_bool(item) for item in gdf[column_name].tolist()]
    normalized = [default_value if item is None else item for item in values]
    return pd.Series(normalized, index=gdf.index, dtype="object")


def _normalize_columns(
    gdf: gpd.GeoDataFrame,
    export_columns: tuple[str, ...],
    aliases: dict[str, list[str]],
    defaults: dict[str, Any] | None = None,
    bool_columns: set[str] | None = None,
) -> gpd.GeoDataFrame:
    geometry_column = gdf.geometry.name
    non_geometry_columns = [column for column in gdf.columns if column != geometry_column]
    lookup = _build_column_lookup(non_geometry_columns)
    defaults = defaults or {}
    bool_columns = bool_columns or set()

    normalized: dict[str, pd.Series] = {}
    for column in export_columns:
        candidates = aliases.get(column, [column])
        source_column = _find_column_name(lookup, candidates)
        if column in bool_columns:
            default_bool = bool(defaults.get(column, False))
            normalized[column] = _bool_series_or_default(gdf, source_column, default_value=default_bool)
            continue
        if source_column is None and column in defaults:
            normalized[column] = _constant_series(gdf, defaults[column])
            continue
        normalized[column] = _series_or_empty(gdf, source_column)

    payload = {column: normalized[column] for column in export_columns}
    payload[geometry_column] = gdf[geometry_column]
    return gpd.GeoDataFrame(payload, geometry=geometry_column, crs=gdf.crs)


def _normalize_unit_columns_for_export(
    gdf: gpd.GeoDataFrame,
    imdf_field: str,
    legacy_field: str | None,
) -> gpd.GeoDataFrame:
    normalized = _normalize_columns(
        gdf,
        export_columns=UNIT_EXPORT_COLUMNS,
        aliases={
            "id": ["id"],
            "category": [imdf_field, "category"],
            "restrict": ["restrict", "restriction", "restricted"],
            "name": ["name"],
            "alt_name": ["alt_name", "altname"],
            "level_id": ["level_id", "floor_id", "levelid", "floorid"],
            "source": ["source"],
            "display_po": ["display_po", "display_pt", "displaypoint", "display_point"],
        },
        defaults={"source": 1},
    )

    if legacy_field and legacy_field not in UNIT_EXPORT_COLUMNS:
        legacy_aliases = {legacy_field: [legacy_field]}
        normalized = _normalize_columns(
            normalized,
            export_columns=(*UNIT_EXPORT_COLUMNS, legacy_field),
            aliases={
                "id": ["id"],
                "category": ["category"],
                "restrict": ["restrict"],
                "name": ["name"],
                "alt_name": ["alt_name"],
                "level_id": ["level_id"],
                "source": ["source"],
                "display_po": ["display_po"],
                **legacy_aliases,
            },
            defaults={"source": 1},
        )

    return normalized


def _normalize_opening_columns_for_export(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return _normalize_columns(
        gdf,
        export_columns=OPENING_EXPORT_COLUMNS,
        aliases={
            "id": ["id"],
            "name": ["name"],
            "source": ["source"],
            "category": ["category", "type"],
            "access_con": ["access_con", "access_control", "accessctrl", "access_ctrl"],
            "door": ["door"],
            "alt_name": ["alt_name", "altname"],
            "level_id": ["level_id", "floor_id", "levelid", "floorid"],
            "display_po": ["display_po", "display_pt", "displaypoint", "display_point"],
        },
        defaults={"source": 1},
    )


def _normalize_fixture_columns_for_export(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return _normalize_columns(
        gdf,
        export_columns=FIXTURE_EXPORT_COLUMNS,
        aliases={
            "id": ["id"],
            "category": ["category"],
            "source": ["source"],
            "name": ["name"],
            "alt_name": ["alt_name", "altname"],
            "level_id": ["level_id", "floor_id", "levelid", "floorid"],
            "display_po": ["display_po", "display_pt", "displaypoint", "display_point"],
        },
        defaults={"source": 1},
    )


def _normalize_detail_columns_for_export(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return _normalize_columns(
        gdf,
        export_columns=DETAIL_EXPORT_COLUMNS,
        aliases={
            "id": ["id"],
            "level_id": ["level_id", "floor_id", "levelid", "floorid"],
            "category": ["category", "type"],
            "source": ["source"],
        },
        defaults={"source": 1},
    )


def _normalize_level_columns_for_export(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    return _normalize_columns(
        gdf,
        export_columns=LEVEL_EXPORT_COLUMNS,
        aliases={
            "id": ["id"],
            "name": ["name"],
            "source": ["source"],
            "restrict": ["restrict", "restriction", "restricted"],
            "display_po": ["display_po", "display_pt", "displaypoint", "display_point"],
            "short_name": ["short_name", "shortname"],
            "outdoor": ["outdoor"],
            "ordinal": ["ordinal"],
            "address_id": ["address_id", "addr_id"],
        },
        defaults={"source": 1, "outdoor": False},
        bool_columns={"outdoor"},
    )


def _should_normalize_unit_schema(
    session: SessionRecord,
    imdf_field: str,
) -> bool:
    target = imdf_field.strip().lower()
    if target == "category":
        return True
    code_column = (session.wizard.mappings.unit.code_column or "").strip()
    if not code_column:
        return False
    normalized_code = _normalize_shapefile_field_name(code_column, code_column)
    return target in {code_column.lower(), normalized_code.lower()}


def _build_export_report(request: ShapefileExportRequest) -> dict[str, Any]:
    return {
        "mode": request.mode,
        "encoding": request.encoding,
        "legacy_code_map_source": "none",
        "legacy_code_conflicts": [],
        "unit_schema_normalized_stems": [],
        "opening_schema_normalized_stems": [],
        "fixture_schema_normalized_stems": [],
        "detail_schema_normalized_stems": [],
        "level_schema_normalized_stems": [],
        "unit_stem_renames": [],
        "stem_renames": [],
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
    detected_type_by_stem = _detected_type_by_stem(session)
    normalize_unit_schema = _should_normalize_unit_schema(session, imdf_field)

    with tempfile.TemporaryDirectory() as tmpdir:
        output_dir = Path(tmpdir)
        used_output_stems: set[str] = set()

        for stem, components in sorted(shapefile_groups.items()):
            shapefile_path = components[".shp"]
            gdf = gpd.read_file(shapefile_path)
            detected_type = _resolved_export_feature_type(
                stem,
                detected_type_by_stem.get(stem, ""),
            )
            is_unit_stem = detected_type == "unit"
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

            if detected_type == "unit" and normalize_unit_schema:
                gdf = _normalize_unit_columns_for_export(
                    gdf,
                    imdf_field=imdf_field,
                    legacy_field=legacy_field,
                )
                report["unit_schema_normalized_stems"].append(stem)
            elif detected_type == "opening":
                gdf = _normalize_opening_columns_for_export(gdf)
                report["opening_schema_normalized_stems"].append(stem)
            elif detected_type == "fixture":
                gdf = _normalize_fixture_columns_for_export(gdf)
                report["fixture_schema_normalized_stems"].append(stem)
            elif detected_type == "detail":
                gdf = _normalize_detail_columns_for_export(gdf)
                report["detail_schema_normalized_stems"].append(stem)
            elif detected_type == "level":
                gdf = _normalize_level_columns_for_export(gdf)
                report["level_schema_normalized_stems"].append(stem)

            output_stem = _normalized_output_stem(stem, detected_type)
            if output_stem != stem:
                report["stem_renames"].append(
                    {
                        "from": stem,
                        "to": output_stem,
                        "feature_type": detected_type or "unknown",
                    }
                )
                if detected_type == "unit":
                    report["unit_stem_renames"].append(
                        {
                            "from": stem,
                            "to": output_stem,
                        }
                    )

            output_stem = _make_unique_stem(output_stem, used_output_stems)
            destination = output_dir / f"{output_stem}.shp"
            write_kwargs: dict[str, Any] = {"driver": "ESRI Shapefile", "index": False}
            if write_encoding is not None:
                write_kwargs["encoding"] = write_encoding
            gdf.to_file(destination, **write_kwargs)
            report["stems_processed"].append(
                {
                    "stem": stem,
                    "output_stem": output_stem,
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
