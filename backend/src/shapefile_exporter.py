"""Shapefile round-trip export helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
import json
from dataclasses import dataclass
from pathlib import Path
import re
import tempfile
from typing import Any
from uuid import UUID, uuid4
import zipfile

import geopandas as gpd
import pandas as pd
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.src.mapper import normalize_restriction
from backend.src.odc_qgis import OdcQgisLayer, build_odc_qgs_project
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
    "category",
    "name",
    "source",
    "restrict",
    "display_po",
    "short_name",
    "outdoor",
    "ordinal",
    "address_id",
)
CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


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


def _canonicalize_uuid_value(value: Any) -> Any:
    if value is None:
        return None
    if not isinstance(value, str):
        try:
            if pd.isna(value):
                return None
        except Exception:
            pass
        return value

    candidate = value.strip()
    if not candidate:
        return None
    try:
        return str(UUID(candidate))
    except ValueError:
        return value


def _canonicalize_uuid_columns(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    geometry_column = gdf.geometry.name
    uuid_fields = {"id", "level_id", "floor_id", "address_id", "anchor_id"}
    renamed: dict[str, pd.Series] = {}
    for column in gdf.columns:
        if column == geometry_column:
            continue
        if column.strip().lower() not in uuid_fields:
            continue
        renamed[column] = gdf[column].astype("object").map(_canonicalize_uuid_value)
    if not renamed:
        return gdf
    return gdf.assign(**renamed)


# ODC ids are delivered as bare hex - the datasets this feeds do not use the
# dashed form. Only the roundtrip profile keeps it (`_canonicalize_uuid_value`),
# because there the id has to match the source shapefile it is written back to.
ODC_UUID_FIELDS = ("id", "floor_id")


def _odc_uuid_value(value: Any) -> Any:
    """``value`` as an undashed UUID, or unchanged when it is not a UUID.

    An id the spec never issued (a source key like ``shop-12``) keeps its
    dashes: they are part of what it says, not formatting.
    """
    canonical = _canonicalize_uuid_value(value)
    if not isinstance(canonical, str):
        return canonical
    try:
        return UUID(canonical).hex
    except ValueError:
        return canonical


def _compact_uuid_columns(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    renamed = {
        column: gdf[column].astype("object").map(_odc_uuid_value)
        for column in ODC_UUID_FIELDS
        if column in gdf.columns
    }
    return gdf.assign(**renamed) if renamed else gdf


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
            "category": ["category"],
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


@dataclass(frozen=True)
class CategoryCodes:
    """One spec code family (別表 A / B / C), indexed for export.

    `codes_by_category` is the spec table inverted, preferred code first: the
    ODC tables are finer-grained than IMDF, so several codes share a category
    (B011-B014 are all 多機能トイレ) and the winner has to be declared rather
    than left to sort order. `aliases` folds source vocabulary that is not IMDF
    ("store_sta", "ticket office") onto the category it means.
    """

    codes_by_category: dict[str, list[str]]
    preferred: dict[str, str]
    aliases: dict[str, str]


def _text_map(payload: dict[str, Any], key: str) -> dict[str, str]:
    value = payload.get(key)
    if not isinstance(value, dict):
        return {}
    return {
        str(left).strip().lower(): str(right).strip()
        for left, right in value.items()
        if str(left).strip() and str(right).strip()
    }


def _load_category_codes(filename: str) -> CategoryCodes:
    path = CONFIG_DIR / filename
    payload: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            payload = loaded if isinstance(loaded, dict) else {}
        except Exception:
            payload = {}
    mappings = payload.get("mappings", {})
    if not isinstance(mappings, dict):
        mappings = {}
    preferred = {category: code.upper() for category, code in _text_map(payload, "preferred").items()}
    aliases = {source: category.lower() for source, category in _text_map(payload, "aliases").items()}

    codes_by_category: dict[str, list[str]] = {}
    for code, category in mappings.items():
        code_text = str(code).strip().upper()
        category_text = str(category).strip().lower()
        if code_text and category_text:
            codes_by_category.setdefault(category_text, []).append(code_text)
    for category, codes in codes_by_category.items():
        codes.sort()
        winner = preferred.get(category)
        if winner in codes:
            codes.remove(winner)
            codes.insert(0, winner)
    return CategoryCodes(codes_by_category=codes_by_category, preferred=preferred, aliases=aliases)


def _feature_rows(session: SessionRecord) -> list[dict[str, Any]]:
    rows = session.feature_collection.get("features", [])
    return rows if isinstance(rows, list) else []


def _feature_properties(feature: dict[str, Any]) -> dict[str, Any]:
    properties = feature.get("properties")
    return properties if isinstance(properties, dict) else {}


def _feature_metadata(feature: dict[str, Any]) -> dict[str, Any]:
    metadata = _feature_properties(feature).get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _metadata_lookup(metadata: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for key in metadata:
        normalized = str(key).strip().lower()
        if normalized and normalized not in lookup:
            lookup[normalized] = str(key)
    return lookup


def _metadata_value(metadata: dict[str, Any], candidates: list[str]) -> Any:
    lookup = _metadata_lookup(metadata)
    for candidate in candidates:
        key = lookup.get(candidate.strip().lower())
        if key is not None:
            return metadata.get(key)
    return None


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    text = str(value).strip()
    return text or None


def _label_text(value: Any) -> str | None:
    if isinstance(value, dict):
        for item in value.values():
            text = _text_or_none(item)
            if text:
                return text
        return None
    return _text_or_none(value)


def _property_or_metadata(feature: dict[str, Any], property_names: list[str], metadata_names: list[str] | None = None) -> Any:
    properties = _feature_properties(feature)
    for name in property_names:
        value = properties.get(name)
        if _text_or_none(value) is not None:
            return value
    metadata = _feature_metadata(feature)
    value = _metadata_value(metadata, metadata_names or property_names)
    if _text_or_none(value) is not None:
        return value
    return None


def _source_value(feature: dict[str, Any]) -> str:
    return _text_or_none(_property_or_metadata(feature, ["source"], ["source"])) or "1"


def _source_code(feature: dict[str, Any], prefix: str, candidates: list[str]) -> str | None:
    # A category that is already a spec code passes through. It can live in the
    # property as well as the source metadata: the review screen writes codes
    # straight onto `category`, and only metadata used to be consulted, so a
    # venue set to A001 by hand still exported as A999.
    value = _property_or_metadata(feature, ["category"], candidates)
    text = _text_or_none(value)
    if text and re.fullmatch(fr"{prefix}\d{{3}}", text.strip(), flags=re.IGNORECASE):
        return text.strip().upper()
    return None


def _source_facility_code(feature: dict[str, Any]) -> str | None:
    value = _property_or_metadata(feature, [], ["category"])
    text = _text_or_none(value)
    if text and re.fullmatch(r"F\d{3}[A-Za-z]?", text.strip(), flags=re.IGNORECASE):
        return text.strip()
    return None


def _code_for_feature_category(
    feature: dict[str, Any],
    prefix: str,
    source_candidates: list[str],
    table: CategoryCodes,
    fallback: str,
    report: dict[str, Any],
) -> str:
    source_code = _source_code(feature, prefix=prefix, candidates=source_candidates)
    if source_code:
        return source_code

    category = _text_or_none(_feature_properties(feature).get("category"))
    if not category:
        report["category_code_fallbacks"].append(
            {"feature_id": str(feature.get("id", "")), "fallback": fallback, "reason": "missing_category"}
        )
        return fallback

    source_category = category.lower()
    resolved = table.aliases.get(source_category, source_category)
    codes = table.codes_by_category.get(resolved, [])
    if not codes:
        report["category_code_fallbacks"].append(
            {
                "feature_id": str(feature.get("id", "")),
                "category": category,
                "fallback": fallback,
                "reason": "missing_mapping",
            }
        )
        return fallback
    if len(codes) > 1 and resolved not in table.preferred:
        report["category_code_ambiguities"].append(
            {
                "feature_id": str(feature.get("id", "")),
                "category": category,
                "selected_code": codes[0],
                "candidate_codes": codes,
            }
        )
    if resolved != source_category:
        key = f"{source_category} -> {resolved} ({codes[0]})"
        report["category_code_aliases"][key] = report["category_code_aliases"].get(key, 0) + 1
    return codes[0]


def _feature_geometry(feature: dict[str, Any]) -> Any | None:
    geometry = feature.get("geometry")
    if isinstance(geometry, dict):
        try:
            geom = shape(geometry)
            if not geom.is_empty:
                return geom
        except Exception:
            return None
    return None


def _metadata_geometry(feature: dict[str, Any], key: str = "__odc_geometry") -> Any | None:
    geometry = _feature_metadata(feature).get(key)
    if isinstance(geometry, dict):
        try:
            geom = shape(geometry)
            if not geom.is_empty:
                return geom
        except Exception:
            return None
    return None


def _feature_id_value(feature: dict[str, Any]) -> str:
    return str(feature.get("id") or uuid4())


def _floor_code_of(text: str | None) -> str | None:
    """Canonical floor code ("1F", "B1F", "M2F") for floor-label text, else None."""
    if not text:
        return None
    match = re.fullmatch(r"\s*(B|M)?(\d+)FL?\s*", text, re.IGNORECASE)
    if not match:
        return None
    return f"{(match.group(1) or '').upper()}{int(match.group(2))}F"


def _odc_floor_token(level: dict[str, Any]) -> str:
    """Floor token for ODC filenames per spec 2.6.1: "1F"->"1", "B1F"->"B1",
    "M2F"->"M2". Labels that are not floor codes (e.g. the outdoor ground level
    named after the venue) fall back to the floor token in the source file stem
    ("JRTokyoSta_0_Floor" -> "0"), then to the ordinal."""
    properties = _feature_properties(level)
    label = _label_text(properties.get("short_name")) or _label_text(properties.get("name"))
    code = _floor_code_of(label)
    if code:
        return code[:-1]
    stem = properties.get("source_file")
    if isinstance(stem, str):
        for candidate in re.findall(r"[A-Za-z0-9]+", stem):
            token = _floor_code_of(candidate)
            if token:
                return token[:-1]
            match = re.fullmatch(r"(B|M)?(\d+)", candidate, re.IGNORECASE)
            if match and len(match.group(2)) <= 2:
                return f"{(match.group(1) or '').upper()}{int(match.group(2))}"
    ordinal = properties.get("ordinal")
    if isinstance(ordinal, (int, float)) and not isinstance(ordinal, bool):
        if ordinal < 0:
            return f"B{abs(int(ordinal))}"
        return str(int(ordinal) + 1)
    return _safe_export_name(str(level.get("id", "level"))[:8])


def _floor_token_of_code(code: str | None) -> str | None:
    """ODC filename token for a canonical floor code ("1F" -> "1", "B1F" -> "B1")."""
    if not code:
        return None
    return code[:-1] if code.upper().endswith("F") else code


def _union_geometries(geoms: list[Any]) -> Any | None:
    present = [geom for geom in geoms if geom is not None and not geom.is_empty]
    if not present:
        return None
    if len(present) == 1:
        return present[0]
    return unary_union(present)


def _nearest_level_for_point(
    levels: list[dict[str, Any]], point: Any
) -> tuple[str | None, float | None]:
    """Nearest Level of one floor and its distance in degrees, if measurable.

    A floor holds several Level features (新宿 2F is ラチ内 / ラチ外 / 屋外), so a
    display point belongs to whichever of them it falls in. Measuring against the
    floor's first level alone drops everything standing on the rest of the floor.
    """
    if not levels:
        return None, None
    if point is None:
        return str(levels[0].get("id")), None
    nearest_id: str | None = None
    nearest_distance = 0.0
    for level in levels:
        geom = _feature_geometry(level)
        if geom is None:
            continue
        distance = geom.distance(point)
        if nearest_id is None or distance < nearest_distance:
            nearest_id, nearest_distance = str(level.get("id")), distance
    if nearest_id is None:
        # No level on this floor carries geometry, so there is nothing to test.
        return str(levels[0].get("id")), None
    return nearest_id, nearest_distance


def _level_id_for_point(
    levels: list[dict[str, Any]], point: Any, tolerance: float
) -> tuple[str | None, float | None]:
    """Level that owns `point`, plus distance in metres to the nearest polygon.

    Distance is the degree measurement converted with DEGREES_PER_METER (the
    same factor used for FACILITY_INSIDE_TOLERANCE_M) and rounded to 2 d.p.
    The level id is None when the point sits farther than `tolerance`.
    """
    nearest_id, nearest_distance = _nearest_level_for_point(levels, point)
    if nearest_id is None or nearest_distance is None:
        return nearest_id, None
    distance_m = round(nearest_distance / DEGREES_PER_METER, 2)
    if nearest_distance <= tolerance:
        return nearest_id, distance_m
    return None, distance_m


def _display_name(feature: dict[str, Any]) -> str | None:
    properties = _feature_properties(feature)
    return _label_text(properties.get("name")) or _text_or_none(_metadata_value(_feature_metadata(feature), ["name"]))


def _address_by_id(features: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        str(feature.get("id")): _feature_properties(feature)
        for feature in features
        if feature.get("feature_type") == "address" and feature.get("id")
    }


def _address_for_feature(feature: dict[str, Any], addresses: dict[str, dict[str, Any]]) -> dict[str, Any]:
    address_id = _feature_properties(feature).get("address_id")
    if isinstance(address_id, str) and address_id in addresses:
        return addresses[address_id]
    return {}


def _safe_layer_stem(*parts: str) -> str:
    cleaned = [_safe_export_name(part) for part in parts if part]
    return "_".join(cleaned) or "layer"




# Opendata is delivered in JGD2011 geographic coordinates; the bundled QGIS
# project has to declare the same CRS the shapefiles were written in.
ODC_EXPORT_CRS = "EPSG:6668"

ODC_POLYGON_GEOMS = ("Polygon", "MultiPolygon")
ODC_LINE_GEOMS = ("LineString", "MultiLineString")
ODC_POINT_GEOMS = ("Point",)

# Every per-floor ODC file is named "<base>_<floor token>_<layer>.shp".
ODC_FLOOR_LAYER_GEOMS: dict[str, tuple[str, ...]] = {
    "Floor": ODC_POLYGON_GEOMS,
    "Space": ODC_POLYGON_GEOMS,
    "Fixture": ODC_POLYGON_GEOMS,
    "Opening": ODC_LINE_GEOMS,
    "Drawing": ODC_LINE_GEOMS,
    "Facility": ODC_POINT_GEOMS,
}

# ステナビフロアID (Facility_Merge `floor` attribute) → ODC floor code, per spec
# Table 2-2 (the 東京駅 area floor master). Station-specific tokens (SB5, KB4,
# ...) live here; generic F/B/M tokens are resolved in
# `_facility_merge_floor_code` because the table is Tokyo Station's floor
# set and a 4F station would otherwise drop every facility on that floor.
FACILITY_MERGE_FLOOR_MAP = {
    "SB5": "B5F",
    "KB4": "B4F",
    "SB4": "B4F",
    "KB3": "B3F",
    "B2": "B2F",
    "B1": "B1F",
    "F1": "1F",
    "M2": "M2F",
    "F2": "2F",
    "F3": "3F",
}
_GENERIC_FACILITY_MERGE_FLOOR = re.compile(r"^(F|B|M)(\d{1,2})$", re.IGNORECASE)


def _facility_merge_floor_code(floor_attr: str | None) -> str | None:
    """Resolve a Facility_Merge `floor` value to an ODC floor code.

    Table entries win so 東京駅-specific ids (SB5, KB4, ...) keep their mapped
    codes. The table alone is not enough: it is the Tokyo Station master and
    has no F4/F5/..., so a station with a 4F would silently drop those rows.
    Generic Stenavi tokens are therefore handled in code: F<n> -> <n>F,
    B<n> -> B<n>F, M<n> -> M<n>F (1-2 digits, case-insensitive).
    """
    if not floor_attr:
        return None
    token = floor_attr.strip().upper()
    if token in FACILITY_MERGE_FLOOR_MAP:
        return FACILITY_MERGE_FLOOR_MAP[token]
    match = _GENERIC_FACILITY_MERGE_FLOOR.fullmatch(token)
    if not match:
        return None
    kind, number = match.group(1).upper(), str(int(match.group(2)))
    if kind == "F":
        return f"{number}F"
    return f"{kind}{number}F"

# The opendata Building layer carries a single building (the station itself)
# whose polygon is the ground-floor (1F) level shape.
ODC_GROUND_FLOOR_CODE = "1F"
# Facility_Merge display points may sit fractionally off the level outline;
# anything beyond this distance from its own floor's Level polygon belongs to a
# neighbouring facility (Yaesu underground, Metro, the towers) and is dropped.
FACILITY_INSIDE_TOLERANCE_M = 0.5
DEGREES_PER_METER = 1 / 111_320

# 地図記号 image → 別表8.3.1 設備POI F-code. Unlisted icons (children, bus,
# taxi, prayer, K01, map_rogo, store, platform logos, etc.) export as null.
FACILITY_MERGE_IMAGE_F_CODES = {
    "male": "F001",
    "female": "F002",
    "unisex": "F003",
    "multipurpose": "F005",
    "stairs_up": "F011",
    "stairs_down": "F011",
    "elevator": "F012",
    "elevator_up": "F012",
    "elevator_down": "F012",
    "escalator": "F013",
    "slope": "F014",
    "info": "F018",
    "smoking": "F024",
    "locker": "F031",
    "ticket": "F101",
    "mv": "F101",
    "exchange": "F214",
}


def _facility_merge_f_code(metadata: dict[str, Any]) -> str | None:
    """設備POI F-code (別表8.3.1) for a Facility_Merge row.

    Driven by the 地図記号 image basename. `baby.png` is F021 unless the row
    is toilet-related (category/name contains toilet/トイレ), in which case
    it is null. Icons not in the map export as null.
    """
    image = _text_or_none(_metadata_value(metadata, ["image"]))
    if not image:
        return None
    basename = image.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
    if basename == "baby":
        source_category = (_text_or_none(_metadata_value(metadata, ["category"])) or "").lower()
        name = (_text_or_none(_metadata_value(metadata, ["name"])) or "").lower()
        if "toilet" in source_category or "toilet" in name or "トイレ" in name:
            return None
        return "F021"
    return FACILITY_MERGE_IMAGE_F_CODES.get(basename)


def _is_facility_merge_feature(feature: dict[str, Any]) -> bool:
    stem = _feature_properties(feature).get("source_file")
    return isinstance(stem, str) and "facility_merge" in stem.lower()


def _write_odc_layer(
    output_dir: Path,
    stem: str,
    rows: list[dict[str, Any]],
    geometries: list[Any],
    write_encoding: str | None,
    allowed_geoms: tuple[str, ...],
    report: dict[str, Any],
) -> tuple[float, float, float, float] | None:
    """Write one ODC layer; returns its extent, or None when nothing was written."""
    kept_rows: list[dict[str, Any]] = []
    kept_geoms: list[Any] = []
    for row, geom in zip(rows, geometries):
        if geom.geom_type in allowed_geoms:
            kept_rows.append(row)
            kept_geoms.append(geom)
        else:
            report["rows_skipped"].append(
                {"layer": stem, "feature_id": row.get("id"), "geometry_type": geom.geom_type}
            )
    rows, geometries = kept_rows, kept_geoms
    if not rows or not geometries:
        return None
    gdf = _compact_uuid_columns(gpd.GeoDataFrame(rows, geometry=geometries, crs="EPSG:4326"))
    gdf = gdf.to_crs(ODC_EXPORT_CRS)
    destination = output_dir / f"{stem}.shp"
    write_kwargs: dict[str, Any] = {"driver": "ESRI Shapefile", "index": False}
    if write_encoding is not None:
        write_kwargs["encoding"] = write_encoding
    gdf.to_file(destination, **write_kwargs)
    xmin, ymin, xmax, ymax = gdf.total_bounds
    return float(xmin), float(ymin), float(xmax), float(ymax)


def _space_categories(
    rows: list[dict[str, Any]], labels: dict[str, str]
) -> tuple[tuple[str, str], ...]:
    """Sorted (code, legend label) pairs for the Space codes present in `rows`.

    The bundled QGIS project needs the values enumerated, because a categorized
    renderer holds one symbol per value: it can only color what was written.
    """
    codes = sorted({text for row in rows if (text := _text_or_none(row.get("category")))})
    return tuple((code, labels.get(code, code)) for code in codes)


def _odc_report(request: ShapefileExportRequest) -> dict[str, Any]:
    return {
        "profile": request.profile,
        "encoding": request.encoding,
        "layers_written": [],
        "qgis_project": None,
        "layers_skipped": [],
        "rows_skipped": [],
        "category_code_ambiguities": [],
        "category_code_aliases": {},
        "category_code_fallbacks": [],
        "facility_merge_unmapped": [],
        "facility_merge_outside_building": [],
        "facility_merge_missing_category": [],
    }


def _write_odc2026_shapefiles(
    session: SessionRecord,
    request: ShapefileExportRequest,
    output_dir: Path,
) -> tuple[dict[str, Any], str, list[OdcQgisLayer]]:
    if any(item.source_format != "shapefile" for item in session.files):
        raise ValueError(
            "Open Data Contest 2026 shapefile export unavailable: this session includes GeoPackage sources. "
            "Use IMDF export instead."
        )

    if not request.export_name or not request.export_name.strip():
        raise ValueError("Open data export requires a file name prefix.")

    features = _feature_rows(session)
    report = _odc_report(request)
    write_encoding = _encoding_for_write(request.encoding)
    base = _safe_export_name(request.export_name)
    addresses = _address_by_id(features)
    a_codes = _load_category_codes("a-codes.json")
    b_codes = _load_category_codes("b-codes.json")
    c_codes = _load_category_codes("c-codes.json")
    # The bundled QGIS project colors Space by its 別表8.2.4 code; the legend
    # reads "B001 retail" rather than the bare code.
    b_code_labels = {
        code: f"{code} {category}"
        for category, codes in b_codes.codes_by_category.items()
        for code in codes
    }
    qgis_layers: list[OdcQgisLayer] = []

    levels = sorted(
        [item for item in features if item.get("feature_type") == "level"],
        key=lambda item: _feature_properties(item).get("ordinal")
        if isinstance(_feature_properties(item).get("ordinal"), (int, float))
        else 0,
    )
    level_ids = {str(item.get("id")) for item in levels if item.get("id")}
    features_by_level: dict[str, dict[str, list[dict[str, Any]]]] = {
        level_id: {"unit": [], "fixture": [], "opening": [], "detail": [], "amenity": []}
        for level_id in level_ids
    }
    # ODC names each per-floor file after its floor token, and a floor commonly
    # carries several Level features (新宿 2F is ラチ内 / ラチ外 / 屋外), so a token
    # keeps every one of its levels instead of an arbitrary first one.
    floor_token_by_level_id: dict[str, str] = {}
    levels_by_floor_token: dict[str, list[dict[str, Any]]] = {}
    for level in levels:
        if not level.get("id"):
            continue
        token = _odc_floor_token(level)
        floor_token_by_level_id[str(level.get("id"))] = token
        levels_by_floor_token.setdefault(token, []).append(level)
    # The Building polygon is the whole ground floor, every 1F level included.
    ground_level_geom = _union_geometries(
        [
            _feature_geometry(level)
            for level in levels_by_floor_token.get(_floor_token_of_code(ODC_GROUND_FLOOR_CODE) or "", [])
        ]
    )
    inside_tolerance = FACILITY_INSIDE_TOLERANCE_M * DEGREES_PER_METER
    facility_merge_active = any(
        feature.get("feature_type") == "amenity" and _is_facility_merge_feature(feature)
        for feature in features
    )
    unit_level_by_id = {
        str(item.get("id")): _feature_properties(item).get("level_id")
        for item in features
        if item.get("feature_type") == "unit" and item.get("id")
    }
    anchor_unit_by_id = {
        str(item.get("id")): _feature_properties(item).get("unit_id")
        for item in features
        if item.get("feature_type") == "anchor" and item.get("id")
    }

    def _poi_level_id(feature: dict[str, Any]) -> str | None:
        candidate = _metadata_value(_feature_metadata(feature), ["__odc_level_id"])
        if isinstance(candidate, str) and candidate in level_ids:
            return candidate
        props = _feature_properties(feature)
        unit_refs = props.get("unit_ids")
        if isinstance(unit_refs, list) and unit_refs:
            candidate = unit_level_by_id.get(str(unit_refs[0]))
            if isinstance(candidate, str) and candidate in level_ids:
                return candidate
        anchor_ref = props.get("anchor_id")
        if isinstance(anchor_ref, str):
            candidate = unit_level_by_id.get(str(anchor_unit_by_id.get(anchor_ref)))
            if isinstance(candidate, str) and candidate in level_ids:
                return candidate
        return None

    for feature in features:
        feature_type = str(feature.get("feature_type") or "")
        if feature_type not in {"unit", "fixture", "opening", "detail", "amenity"}:
            continue
        if feature_type == "amenity":
            if facility_merge_active:
                # Facility layers are built from Facility_Merge (ステナビ地図記号
                # 表示点); its semantic categories are mapped to 別表8.3.1 F-codes
                # and per-floor *_Facility.shp amenities are superseded.
                if not _is_facility_merge_feature(feature):
                    continue
                floor_attr = _text_or_none(_metadata_value(_feature_metadata(feature), ["floor"]))
                floor_code = _facility_merge_floor_code(floor_attr)
                floor_levels = levels_by_floor_token.get(_floor_token_of_code(floor_code) or "", [])
                if floor_code is None:
                    report["facility_merge_unmapped"].append(
                        {
                            "feature_id": str(feature.get("id", "")),
                            "floor": floor_attr,
                            "reason": "unknown_floor_token",
                        }
                    )
                    continue
                if not floor_levels:
                    report["facility_merge_unmapped"].append(
                        {
                            "feature_id": str(feature.get("id", "")),
                            "floor": floor_attr,
                            "reason": "no_level_for_floor",
                        }
                    )
                    continue
                level_id, distance_m = _level_id_for_point(
                    floor_levels, _feature_geometry(feature), inside_tolerance
                )
                if level_id is None:
                    report["facility_merge_outside_building"].append(
                        {
                            "feature_id": str(feature.get("id", "")),
                            "floor": floor_attr,
                            "distance_m": distance_m,
                        }
                    )
                    continue
            else:
                level_id = _poi_level_id(feature)
                if level_id is None:
                    report["rows_skipped"].append(
                        {"layer": feature_type, "feature_id": str(feature.get("id", "")), "reason": "unresolved_level"}
                    )
                    continue
            features_by_level[level_id][feature_type].append(feature)
            continue
        level_id = _feature_properties(feature).get("level_id")
        if isinstance(level_id, str) and level_id in features_by_level:
            features_by_level[level_id][feature_type].append(feature)
        else:
            report["rows_skipped"].append(
                {"layer": feature_type, "feature_id": str(feature.get("id", "")), "reason": "unresolved_level"}
            )

    def _emit() -> None:


        site_rows: list[dict[str, Any]] = []
        site_geoms: list[Any] = []
        for venue in features:
            if venue.get("feature_type") != "venue":
                continue
            geom = _feature_geometry(venue)
            if geom is None:
                continue
            address = _address_for_feature(venue, addresses)
            site_rows.append(
                {
                    "id": _feature_id_value(venue),
                    "postalcode": _text_or_none(address.get("postal_code")),
                    "country": _text_or_none(address.get("country")),
                    "province": _text_or_none(address.get("province")),
                    "city": _text_or_none(address.get("locality")),
                    "address1": _text_or_none(address.get("address")),
                    "address2": None,
                    "address3": None,
                    "address4": None,
                    "category": _code_for_feature_category(
                        venue,
                        prefix="A",
                        source_candidates=["category"],
                        table=a_codes,
                        fallback="A999",
                        report=report,
                    ),
                    "hours1": _text_or_none(_feature_properties(venue).get("hours")),
                    "hours2": None,
                    "name": _display_name(venue),
                    "phone": _text_or_none(_feature_properties(venue).get("phone")),
                    "website": _text_or_none(_feature_properties(venue).get("website")),
                    "source": _source_value(venue),
                }
            )
            site_geoms.append(geom)
        site_stem = _safe_layer_stem(base, "Site")
        site_bounds = _write_odc_layer(
            output_dir, site_stem, site_rows, site_geoms, write_encoding, ODC_POLYGON_GEOMS, report
        )
        if site_bounds is not None:
            report["layers_written"].append(site_stem)
            qgis_layers.append(OdcQgisLayer(stem=site_stem, kind="Site", bounds=site_bounds))
        else:
            report["layers_skipped"].append({"layer": site_stem, "reason": "no_venue_geometry"})

        fallback_building_geom = None
        if site_geoms:
            fallback_building_geom = unary_union(site_geoms)
        # The Building polygon takes the shape of the ground floor (1F level).
        buildings = [item for item in features if item.get("feature_type") == "building"]
        # The station building is the one named after the venue. This used to
        # match a hardcoded "JR東京駅", so every other station fell through to
        # the first building in the list and only worked by having exactly one.
        venue_name = next(
            (_display_name(item) for item in features if item.get("feature_type") == "venue"),
            None,
        )
        station_building = next(
            (item for item in buildings if venue_name and _display_name(item) == venue_name),
            buildings[0] if buildings else None,
        )
        building_rows: list[dict[str, Any]] = []
        building_geoms: list[Any] = []
        if station_building is not None:
            geom = ground_level_geom or _metadata_geometry(station_building) or fallback_building_geom
            if geom is not None:
                address = _address_for_feature(station_building, addresses)
                building_rows.append(
                    {
                        "id": _feature_id_value(station_building),
                        "postalcode": _text_or_none(address.get("postal_code")),
                        "country": _text_or_none(address.get("country")),
                        "province": _text_or_none(address.get("province")),
                        "city": _text_or_none(address.get("locality")),
                        "address1": _text_or_none(address.get("address")),
                        "address2": None,
                        "address3": None,
                        "address4": None,
                        "name": _display_name(station_building),
                        "source": _source_value(station_building),
                    }
                )
                building_geoms.append(geom)
        building_stem = _safe_layer_stem(base, "Building")
        building_bounds = _write_odc_layer(
            output_dir, building_stem, building_rows, building_geoms, write_encoding, ODC_POLYGON_GEOMS, report
        )
        if building_bounds is not None:
            report["layers_written"].append(building_stem)
            qgis_layers.append(
                OdcQgisLayer(stem=building_stem, kind="Building", bounds=building_bounds)
            )
        else:
            report["layers_skipped"].append({"layer": building_stem, "reason": "no_building_geometry"})

        # One file per floor, not per level. Several Level features share a floor
        # token, so their rows accumulate in one bucket per (floor, layer) and are
        # written once at the end; writing inside this loop made each level of a
        # floor clobber the file the previous level had just written.
        floor_layers: dict[tuple[str, str], tuple[list[dict[str, Any]], list[Any]]] = {}

        def _floor_layer(label: str, layer: str) -> tuple[list[dict[str, Any]], list[Any]]:
            return floor_layers.setdefault((label, layer), ([], []))

        for level in levels:
            level_id = str(level.get("id"))
            label = floor_token_by_level_id.get(level_id) or _odc_floor_token(level)
            level_geom = _feature_geometry(level)
            if level_geom is not None:
                props = _feature_properties(level)
                ordinal = props.get("ordinal")
                floor_rows, floor_geoms = _floor_layer(label, "Floor")
                floor_rows.append(
                    {
                        "id": _feature_id_value(level),
                        "category": "2" if bool(props.get("outdoor")) else "1",
                        "name": _label_text(props.get("name")),
                        "ordinal": float(ordinal) if isinstance(ordinal, (int, float)) and not isinstance(ordinal, bool) else None,
                        "short_name": _label_text(props.get("short_name")),
                        "source": _source_value(level),
                    }
                )
                floor_geoms.append(level_geom)

            grouped = features_by_level.get(level_id, {})
            units = grouped.get("unit", [])
            space_rows, space_geoms = _floor_layer(label, "Space")
            for unit in units:
                geom = _feature_geometry(unit)
                if geom is None:
                    continue
                props = _feature_properties(unit)
                metadata = _feature_metadata(unit)
                nonpublic = _metadata_value(metadata, ["nonpublic"])
                if _text_or_none(nonpublic) is None and str(props.get("category", "")).lower() == "nonpublic":
                    nonpublic = "1"
                space_rows.append(
                    {
                        "id": _feature_id_value(unit),
                        "category": _code_for_feature_category(
                            unit,
                            prefix="B",
                            source_candidates=["category", "imdf_cat"],
                            table=b_codes,
                            fallback="B019",
                            report=report,
                        ),
                        "floor_id": level_id,
                        "name": _label_text(props.get("name")),
                        # Read from the source row first, so a reviewed value
                        # never silently outranks it - and normalized, because
                        # that raw value bypasses the import-time repair.
                        "restricted": normalize_restriction(
                            _text_or_none(_metadata_value(metadata, ["restricted", "restrict", "restriction"]))
                            or _text_or_none(props.get("restriction"))
                        ),
                        "suite": _text_or_none(_metadata_value(metadata, ["suite"])),
                        "nonpublic": _text_or_none(nonpublic),
                        "toll": _text_or_none(_metadata_value(metadata, ["toll"])),
                        "source": _source_value(unit),
                    }
                )
                space_geoms.append(geom)

            fixtures = grouped.get("fixture", [])
            fixture_rows, fixture_geoms = _floor_layer(label, "Fixture")
            for fixture in fixtures:
                geom = _feature_geometry(fixture)
                if geom is None:
                    continue
                fixture_rows.append(
                    {
                        "id": _feature_id_value(fixture),
                        "category": _code_for_feature_category(
                            fixture,
                            prefix="C",
                            source_candidates=["category"],
                            table=c_codes,
                            fallback="C999",
                            report=report,
                        ),
                        "floor_id": level_id,
                        "source": _source_value(fixture),
                    }
                )
                fixture_geoms.append(geom)

            openings = grouped.get("opening", [])
            opening_rows, opening_geoms = _floor_layer(label, "Opening")
            for opening in openings:
                geom = _feature_geometry(opening)
                if geom is None:
                    continue
                opening_rows.append(
                    {
                        "id": _feature_id_value(opening),
                        "floor_id": level_id,
                        "name": _display_name(opening),
                        "source": _source_value(opening),
                    }
                )
                opening_geoms.append(geom)

            details = grouped.get("detail", [])
            drawing_rows, drawing_geoms = _floor_layer(label, "Drawing")
            for detail in details:
                geom = _feature_geometry(detail)
                if geom is None:
                    continue
                drawing_rows.append(
                    {
                        "id": _feature_id_value(detail),
                        "floor_id": level_id,
                        "source": _source_value(detail),
                    }
                )
                drawing_geoms.append(geom)

            amenities = grouped.get("amenity", [])
            facility_rows, facility_geoms = _floor_layer(label, "Facility")
            for amenity in amenities:
                geom = _feature_geometry(amenity)
                if geom is None:
                    continue
                if facility_merge_active:
                    # Facility_Merge rows carry a semantic category and a 地図記号
                    # image; both resolve to the 別表8.3.1 F-code column.
                    metadata = _feature_metadata(amenity)
                    category = _facility_merge_f_code(metadata)
                    if category is None:
                        floor_attr = _text_or_none(_metadata_value(metadata, ["floor"]))
                        report["facility_merge_missing_category"].append(
                            {"feature_id": _feature_id_value(amenity), "floor": floor_attr}
                        )
                else:
                    category = _source_facility_code(amenity)
                facility_rows.append(
                    {
                        "id": _feature_id_value(amenity),
                        "category": category,
                        "floor_id": level_id,
                        "name": _display_name(amenity),
                        "source": _source_value(amenity),
                    }
                )
                facility_geoms.append(geom)

        for (label, layer), (rows, geoms) in floor_layers.items():
            stem = _safe_layer_stem(base, label, layer)
            bounds = _write_odc_layer(
                output_dir, stem, rows, geoms, write_encoding, ODC_FLOOR_LAYER_GEOMS[layer], report
            )
            if bounds is not None:
                report["layers_written"].append(stem)
                qgis_layers.append(
                    OdcQgisLayer(
                        stem=stem,
                        kind=layer,
                        floor=label,
                        categories=_space_categories(rows, b_code_labels) if layer == "Space" else (),
                        bounds=bounds,
                    )
                )

    _emit()
    return report, base, qgis_layers


def _write_odc_qgis_project(
    output_dir: Path,
    base: str,
    layers: list[OdcQgisLayer],
    request: ShapefileExportRequest,
    report: dict[str, Any],
) -> None:
    """Drop a ready-to-open QGIS project beside the shapefiles it references."""
    if not layers:
        report["layers_skipped"].append({"layer": f"{base}_qgis.qgs", "reason": "no_layers_written"})
        return
    filename = f"{base}_qgis.qgs"
    (output_dir / filename).write_text(
        build_odc_qgs_project(
            layers,
            project_name=base,
            crs=ODC_EXPORT_CRS,
            # What the DBFs were written in; "preserve_source" leaves the
            # pyogrio default, which is UTF-8.
            encoding=_encoding_for_write(request.encoding) or "UTF-8",
        ),
        encoding="utf-8",
    )
    report["qgis_project"] = filename


def build_odc2026_shapefile_export_archive(
    session: SessionRecord,
    request: ShapefileExportRequest,
) -> tuple[bytes, str]:
    """Open Data Contest 2026 shapefile bundle (.zip), with a QGIS project."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        report, base, layers = _write_odc2026_shapefiles(session, request, out)
        _write_odc_qgis_project(out, base, layers, request, report)
        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for exported_file in sorted(out.glob("*")):
                if exported_file.is_file():
                    archive.write(exported_file, arcname=exported_file.name)
            if request.include_report:
                archive.writestr("export_report.json", json.dumps(report, ensure_ascii=False, indent=2))
    return archive_bytes.getvalue(), f"{base}_odc2026_shapefiles.zip"


def build_qgis_project_archive(
    session: SessionRecord,
    request: ShapefileExportRequest,
) -> tuple[bytes, str]:
    """Styled QGIS project (.qgz) bundled with its ODC2026 source shapefiles.

    The .qgz stores relative paths, so extracting the zip and opening the
    project resolves every sibling shapefile automatically.
    """
    from backend.src.qgis_export import generate_qgis_project_for_folder

    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir)
        report, base, _layers = _write_odc2026_shapefiles(session, request, out)
        qgz_name = f"{base}_qgis.qgz"
        generate_qgis_project_for_folder(out, out / qgz_name, base)
        archive_bytes = BytesIO()
        with zipfile.ZipFile(archive_bytes, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for exported_file in sorted(out.glob("*")):
                if exported_file.is_file():
                    archive.write(exported_file, arcname=exported_file.name)
            if request.include_report:
                archive.writestr("export_report.json", json.dumps(report, ensure_ascii=False, indent=2))
    return archive_bytes.getvalue(), f"{base}_qgis_project.zip"


def build_shapefile_export_archive(
    session: SessionRecord,
    request: ShapefileExportRequest,
) -> tuple[bytes, str]:
    if request.profile == "odc2026":
        return build_odc2026_shapefile_export_archive(session=session, request=request)

    if any(item.source_format != "shapefile" for item in session.files):
        raise ValueError(
            "Shapefile export unavailable: this session includes GeoPackage sources. "
            "Use IMDF export instead."
        )

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

            # Canonicalize legacy 32-char UUID strings to hyphenated UUID format.
            gdf = _canonicalize_uuid_columns(gdf)

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
