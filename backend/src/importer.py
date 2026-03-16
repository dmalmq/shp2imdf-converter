"""Geospatial import pipeline for Phase 1."""

from __future__ import annotations

from collections import Counter, defaultdict
import copy
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import re
import tempfile
from typing import Any, Sequence
from uuid import uuid4
import zipfile

import fiona
import geopandas as gpd
import pandas as pd
from pyproj import CRS
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiLineString, MultiPoint, MultiPolygon, Polygon, mapping, shape
from shapely.geometry.polygon import orient

from backend.src.detector import detect_files, load_keyword_map
from backend.src.schemas import CleanupSummary, ImportedFile


SUPPORTED_SHAPEFILE_EXTENSIONS = {
    ".shp",
    ".shx",
    ".dbf",
    ".prj",
    ".cpg",
    ".qix",
}
SUPPORTED_GPKG_EXTENSIONS = {".gpkg"}
SUPPORTED_SOURCE_EXTENSIONS = SUPPORTED_SHAPEFILE_EXTENSIONS | SUPPORTED_GPKG_EXTENSIONS
INTERNAL_SOURCE_COLUMNS = {"_source_row_index", "_source_part_index"}
GEOPACKAGE_NORMALIZATION_WARNING_PREFIX = "GeoPackage normalization:"
POLYGON_GEOMETRY_SOURCE_TYPES = {"unit", "level", "fixture"}
LINE_GEOMETRY_SOURCE_TYPES = {"opening", "detail"}


@dataclass(slots=True)
class ImportArtifacts:
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    source_feature_collection: dict[str, Any]
    feature_collection: dict[str, Any]
    warnings: list[str]


@dataclass(slots=True)
class LoadedSource:
    stem: str
    source_format: str
    source_layer: str | None
    gdf: gpd.GeoDataFrame
    warnings: list[str]
    crs_detected: str | None


def _expand_archives(file_blobs: Sequence[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    expanded: list[tuple[str, bytes]] = []
    for name, content in file_blobs:
        if name.lower().endswith(".zip"):
            with zipfile.ZipFile(BytesIO(content)) as archive:
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    expanded.append((Path(info.filename).name, archive.read(info.filename)))
            continue
        expanded.append((Path(name).name, content))
    return expanded


def _group_shapefile_components(file_blobs: Sequence[tuple[str, bytes]]) -> dict[str, dict[str, bytes]]:
    grouped: dict[str, dict[str, bytes]] = {}
    for name, content in file_blobs:
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_SHAPEFILE_EXTENSIONS:
            continue
        stem = Path(name).stem
        grouped.setdefault(stem, {})[suffix] = content
    return grouped


def _collect_geopackage_blobs(file_blobs: Sequence[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    geopackages: list[tuple[str, bytes]] = []
    for name, content in file_blobs:
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_GPKG_EXTENSIONS:
            continue
        geopackages.append((Path(name).stem, content))
    return geopackages


def _sanitize_layer_name(layer_name: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9]+", "_", layer_name.strip())
    return sanitized.strip("_") or "layer"


def _make_unique_stem(stem: str, used_lower: set[str]) -> str:
    candidate = stem
    suffix = 2
    while candidate.lower() in used_lower:
        candidate = f"{stem}_{suffix}"
        suffix += 1
    used_lower.add(candidate.lower())
    return candidate


def _close_ring(coords: list[tuple[float, float]], summary: CleanupSummary) -> list[tuple[float, float]]:
    if not coords:
        return coords
    if coords[0] != coords[-1]:
        summary.rings_closed += 1
        return [*coords, coords[0]]
    return coords


def _normalize_polygon(polygon: Polygon, summary: CleanupSummary) -> Polygon:
    exterior = _close_ring(list(polygon.exterior.coords), summary)
    interiors = [_close_ring(list(ring.coords), summary) for ring in polygon.interiors]
    rebuilt = Polygon(exterior, interiors)
    oriented = orient(rebuilt, sign=1.0)
    if rebuilt.wkt != oriented.wkt:
        summary.features_reoriented += 1
    return oriented


def _normalize_geometry(geom: Any, summary: CleanupSummary) -> Any:
    if geom is None:
        return None
    if isinstance(geom, Polygon):
        return _normalize_polygon(geom, summary)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([_normalize_polygon(part, summary) for part in geom.geoms])
    return geom


def _round_json_value(value: Any, precision: int, summary: CleanupSummary) -> Any:
    if isinstance(value, float):
        rounded = round(value, precision)
        if rounded != value:
            summary.coordinates_rounded += 1
        return rounded
    if isinstance(value, list):
        return [_round_json_value(item, precision, summary) for item in value]
    if isinstance(value, tuple):
        return tuple(_round_json_value(item, precision, summary) for item in value)
    if isinstance(value, dict):
        return {key: _round_json_value(item, precision, summary) for key, item in value.items()}
    return value


def _round_geometry(geom: Any, precision: int, summary: CleanupSummary) -> Any:
    rounded_mapping = _round_json_value(mapping(geom), precision, summary)
    return shape(rounded_mapping)


def _explode_geometry_parts(geom: Any, summary: CleanupSummary | None = None) -> list[Any]:
    if geom is None:
        return []
    if isinstance(geom, MultiPolygon):
        if summary is not None:
            summary.multipolygons_exploded += max(0, len(geom.geoms) - 1)
        exploded: list[Any] = []
        for part in geom.geoms:
            exploded.extend(_explode_geometry_parts(part, summary))
        return exploded
    if isinstance(geom, (MultiLineString, MultiPoint, GeometryCollection)):
        exploded: list[Any] = []
        for part in geom.geoms:
            exploded.extend(_explode_geometry_parts(part, summary))
        return exploded
    return [geom]


def _clean_geometry(geom: Any, summary: CleanupSummary, precision: int = 7) -> list[Any]:
    if geom is None:
        summary.empty_features_dropped += 1
        return []

    fixed = make_valid(geom)
    normalized = _normalize_geometry(fixed, summary)
    candidates = _explode_geometry_parts(normalized, summary)

    cleaned: list[Any] = []
    for candidate in candidates:
        if candidate is None or candidate.is_empty:
            summary.empty_features_dropped += 1
            continue
        rounded = _round_geometry(candidate, precision=precision, summary=summary)
        if rounded.is_empty:
            summary.empty_features_dropped += 1
            continue
        cleaned.append(rounded)
    return cleaned


def _infer_geometry_type(gdf: gpd.GeoDataFrame) -> str:
    if gdf.empty:
        return "Unknown"
    unique = sorted(set(str(value) for value in gdf.geom_type.dropna().tolist()))
    if not unique:
        return "Unknown"
    if len(unique) == 1:
        return unique[0]
    return "Mixed"


def _sanitize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and pd.isna(value):
            return None
        return value
    if hasattr(value, "item"):
        return _sanitize_value(value.item())
    if pd.isna(value):
        return None
    return str(value)


def _clean_geodataframe(gdf: gpd.GeoDataFrame, summary: CleanupSummary) -> gpd.GeoDataFrame:
    geometry_column = gdf.geometry.name
    if gdf.empty:
        return gdf

    cleaned_rows: list[dict[str, Any]] = []
    non_geom_columns = [column for column in gdf.columns if column != geometry_column]

    for source_row_index, (_, row) in enumerate(gdf.iterrows()):
        metadata = {column: row[column] for column in non_geom_columns}
        cleaned_geometries = _clean_geometry(row[geometry_column], summary)
        for source_part_index, geometry in enumerate(cleaned_geometries):
            payload = dict(metadata)
            payload["_source_row_index"] = source_row_index
            payload["_source_part_index"] = source_part_index
            payload[geometry_column] = geometry
            cleaned_rows.append(payload)

    if not cleaned_rows:
        return gpd.GeoDataFrame(columns=gdf.columns, geometry=geometry_column, crs=gdf.crs)

    return gpd.GeoDataFrame(cleaned_rows, geometry=geometry_column, crs=gdf.crs)


def _extract_feature_rows(stem: str, gdf: gpd.GeoDataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    geometry_column = gdf.geometry.name
    data_columns = [column for column in gdf.columns if column != geometry_column and column not in INTERNAL_SOURCE_COLUMNS]
    for _, row in gdf.iterrows():
        geometry = row[geometry_column]
        if geometry is None or geometry.is_empty:
            continue
        metadata = {column: _sanitize_value(row[column]) for column in data_columns}
        source_row_index = int(row["_source_row_index"]) if "_source_row_index" in gdf.columns else 0
        source_part_index = int(row["_source_part_index"]) if "_source_part_index" in gdf.columns else 0
        source_feature_ref = f"{stem}:{source_row_index}:{source_part_index}"
        rows.append(
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "source",
                "geometry": mapping(geometry),
                "properties": {
                    "source_file": stem,
                    "source_row_index": source_row_index,
                    "source_part_index": source_part_index,
                    "source_feature_ref": source_feature_ref,
                    "status": "mapped",
                    "issues": [],
                    "metadata": metadata,
                },
            }
        )
    return rows


def _geometry_family_for_detected_type(file_info: ImportedFile) -> str | None:
    if file_info.source_format != "gpkg":
        return None
    detected_type = (file_info.detected_type or "").strip().lower()
    if detected_type in POLYGON_GEOMETRY_SOURCE_TYPES:
        return "polygon"
    if detected_type in LINE_GEOMETRY_SOURCE_TYPES:
        return "line"
    return None


def _geometry_family_for_geom(geom: Any) -> str | None:
    geom_type = str(getattr(geom, "geom_type", "")).lower()
    if "polygon" in geom_type:
        return "polygon"
    if "linestring" in geom_type or geom_type == "linearring":
        return "line"
    if "point" in geom_type:
        return "point"
    return None


def _strip_normalization_warnings(warnings: Sequence[str]) -> list[str]:
    return [warning for warning in warnings if not warning.startswith(GEOPACKAGE_NORMALIZATION_WARNING_PREFIX)]


def _format_dropped_geometry_counts(dropped_counts: Counter[str]) -> str:
    return ", ".join(f"{geom_type} x{count}" for geom_type, count in sorted(dropped_counts.items()))


def _build_normalization_warning(stem: str, expected_family: str, dropped_counts: Counter[str], kept_count: int) -> str:
    dropped_total = sum(dropped_counts.values())
    details = _format_dropped_geometry_counts(dropped_counts)
    family_label = f"{expected_family} geometries"
    if kept_count == 0:
        return (
            f"{GEOPACKAGE_NORMALIZATION_WARNING_PREFIX} '{stem}' has no {family_label} after dropping "
            f"{dropped_total} non-{expected_family} geometry part(s) ({details})."
        )
    return (
        f"{GEOPACKAGE_NORMALIZATION_WARNING_PREFIX} '{stem}' kept {kept_count} {family_label} and dropped "
        f"{dropped_total} non-{expected_family} geometry part(s) ({details})."
    )


def _infer_geometry_type_from_features(features: Sequence[dict[str, Any]]) -> str:
    if not features:
        return "Unknown"

    unique_types: set[str] = set()
    for feature in features:
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict):
            continue
        geom_type = geometry.get("type")
        if isinstance(geom_type, str) and geom_type:
            unique_types.add(geom_type)
    if not unique_types:
        return "Unknown"
    if len(unique_types) == 1:
        return next(iter(unique_types))
    return "Mixed"


def _normalize_feature_geometries(
    feature: dict[str, Any],
    expected_family: str | None,
    dropped_counts: Counter[str],
) -> list[dict[str, Any]]:
    if expected_family is None:
        return [copy.deepcopy(feature)]

    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):
        return []

    geom = shape(geometry)
    atomic_parts = _explode_geometry_parts(geom)
    matching_parts: list[Any] = []
    for part in atomic_parts:
        family = _geometry_family_for_geom(part)
        if family == expected_family:
            matching_parts.append(part)
            continue
        dropped_counts[part.geom_type] += 1

    normalized_features: list[dict[str, Any]] = []
    for index, part in enumerate(matching_parts):
        cloned = copy.deepcopy(feature)
        if index > 0:
            cloned["id"] = str(uuid4())
        cloned["geometry"] = mapping(part)
        normalized_features.append(cloned)
    return normalized_features


def rebuild_normalized_feature_collection(
    source_feature_collection: dict[str, Any],
    files: list[ImportedFile],
) -> tuple[dict[str, Any], list[ImportedFile], list[str]]:
    source_features = source_feature_collection.get("features", [])
    if not isinstance(source_features, list):
        raise ValueError("Feature collection is malformed")

    features_by_stem: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for feature in source_features:
        properties = feature.get("properties")
        if not isinstance(properties, dict):
            continue
        stem = properties.get("source_file")
        if isinstance(stem, str) and stem:
            features_by_stem[stem].append(feature)

    normalized_by_stem: dict[str, list[dict[str, Any]]] = {}
    warnings_by_stem: dict[str, list[str]] = {}
    normalization_warnings: list[str] = []

    for file_info in files:
        expected_family = _geometry_family_for_detected_type(file_info)
        dropped_counts: Counter[str] = Counter()
        kept_features: list[dict[str, Any]] = []

        for feature in features_by_stem.get(file_info.stem, []):
            kept_features.extend(_normalize_feature_geometries(feature, expected_family, dropped_counts))

        file_warnings = _strip_normalization_warnings(file_info.warnings)
        if expected_family is not None and dropped_counts:
            warning = _build_normalization_warning(
                stem=file_info.stem,
                expected_family=expected_family,
                dropped_counts=dropped_counts,
                kept_count=len(kept_features),
            )
            file_warnings.append(warning)
            normalization_warnings.append(warning)

        normalized_by_stem[file_info.stem] = kept_features
        warnings_by_stem[file_info.stem] = file_warnings

    normalized_features: list[dict[str, Any]] = []
    updated_files: list[ImportedFile] = []
    for file_info in files:
        file_features = normalized_by_stem.get(file_info.stem, [])
        normalized_features.extend(file_features)

        updated = file_info.model_copy(deep=True)
        updated.feature_count = len(file_features)
        updated.geometry_type = _infer_geometry_type_from_features(file_features)
        updated.warnings = warnings_by_stem.get(file_info.stem, _strip_normalization_warnings(file_info.warnings))
        updated_files.append(updated)

    return {"type": "FeatureCollection", "features": normalized_features}, updated_files, normalization_warnings


def _reproject_to_wgs84(
    gdf: gpd.GeoDataFrame,
    missing_crs_warning: str | None = None,
) -> tuple[gpd.GeoDataFrame, list[str], str | None]:
    warnings: list[str] = []
    crs_detected = str(gdf.crs) if gdf.crs else None
    if gdf.crs:
        try:
            parsed = CRS.from_user_input(gdf.crs)
            crs_detected = parsed.to_string()
        except Exception:
            pass
        if gdf.crs.to_string() != "EPSG:4326":
            gdf = gdf.to_crs(epsg=4326)
    elif missing_crs_warning:
        warnings.append(missing_crs_warning)
    return gdf, warnings, crs_detected


def _read_shapefile_from_group(stem: str, grouped_files: dict[str, bytes]) -> LoadedSource:
    warnings: list[str] = []
    required = {".shp", ".dbf", ".shx"}
    missing_required = sorted(required - set(grouped_files))
    if missing_required:
        raise ValueError(f"Missing required shapefile sidecars for '{stem}': {', '.join(missing_required)}")
    if ".prj" not in grouped_files:
        warnings.append(f"{stem}: missing .prj; CRS could not be auto-detected.")

    with tempfile.TemporaryDirectory() as tmpdir:
        directory = Path(tmpdir)
        for extension, content in grouped_files.items():
            (directory / f"{stem}{extension}").write_bytes(content)
        shapefile_path = directory / f"{stem}.shp"
        gdf = gpd.read_file(shapefile_path)

    gdf, crs_warnings, crs_detected = _reproject_to_wgs84(gdf)
    warnings.extend(crs_warnings)
    return LoadedSource(
        stem=stem,
        source_format="shapefile",
        source_layer=None,
        gdf=gdf,
        warnings=warnings,
        crs_detected=crs_detected,
    )


def _read_geopackage_blob(
    package_stem: str,
    content: bytes,
    used_stems: set[str],
) -> tuple[list[LoadedSource], list[str]]:
    loaded_sources: list[LoadedSource] = []
    warnings: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        directory = Path(tmpdir)
        package_path = directory / f"{package_stem}.gpkg"
        package_path.write_bytes(content)
        layers = fiona.listlayers(package_path)

        if not layers:
            raise ValueError(f"GeoPackage '{package_stem}' does not contain any layers.")

        for layer_name in layers:
            with fiona.open(package_path, layer=layer_name) as collection:
                geometry_type = str(collection.schema.get("geometry") or "").strip()

            if not geometry_type or geometry_type.lower() == "none":
                warnings.append(f"{package_stem}: skipped non-spatial GeoPackage layer '{layer_name}'.")
                continue

            layer_stem = _make_unique_stem(
                f"{package_stem}__{_sanitize_layer_name(layer_name)}",
                used_stems,
            )
            gdf = gpd.read_file(package_path, layer=layer_name)
            gdf, layer_warnings, crs_detected = _reproject_to_wgs84(
                gdf,
                missing_crs_warning=f"{package_stem}: layer '{layer_name}' is missing CRS metadata.",
            )
            loaded_sources.append(
                LoadedSource(
                    stem=layer_stem,
                    source_format="gpkg",
                    source_layer=layer_name,
                    gdf=gdf,
                    warnings=layer_warnings,
                    crs_detected=crs_detected,
                )
            )

    return loaded_sources, warnings


def import_file_blobs(
    file_blobs: Sequence[tuple[str, bytes]],
    filename_keywords_path: str | Path,
) -> ImportArtifacts:
    if not file_blobs:
        raise ValueError("No files provided.")

    expanded = _expand_archives(file_blobs)
    shapefile_groups = _group_shapefile_components(expanded)
    geopackages = _collect_geopackage_blobs(expanded)
    if not shapefile_groups and not geopackages:
        raise ValueError("No shapefile components or GeoPackages found in upload.")

    summary = CleanupSummary()
    warnings: list[str] = []
    imported_files: list[ImportedFile] = []
    source_features: list[dict[str, Any]] = []
    used_stems = {stem.lower() for stem in shapefile_groups}
    loaded_sources: list[LoadedSource] = []

    for stem, files in sorted(shapefile_groups.items()):
        if ".shp" not in files:
            continue

        loaded_sources.append(_read_shapefile_from_group(stem, files))

    for package_stem, content in geopackages:
        package_sources, package_warnings = _read_geopackage_blob(package_stem, content, used_stems)
        loaded_sources.extend(package_sources)
        warnings.extend(package_warnings)

    if not loaded_sources:
        raise ValueError("No spatial data layers found in upload.")

    for loaded_source in loaded_sources:
        warnings.extend(loaded_source.warnings)
        cleaned = _clean_geodataframe(loaded_source.gdf, summary)
        geometry_type = _infer_geometry_type(cleaned)
        columns = [
            column for column in cleaned.columns if column != cleaned.geometry.name and column not in INTERNAL_SOURCE_COLUMNS
        ]

        imported_files.append(
            ImportedFile(
                stem=loaded_source.stem,
                geometry_type=geometry_type,
                feature_count=int(len(cleaned)),
                attribute_columns=columns,
                source_format=loaded_source.source_format,
                source_layer=loaded_source.source_layer,
                crs_detected=loaded_source.crs_detected,
                warnings=loaded_source.warnings,
            )
        )
        source_features.extend(_extract_feature_rows(loaded_source.stem, cleaned))

    keyword_map = load_keyword_map(filename_keywords_path)
    imported_files = detect_files(imported_files, keyword_map, preserve_manual_levels=False)
    source_feature_collection = {"type": "FeatureCollection", "features": source_features}
    feature_collection, imported_files, normalization_warnings = rebuild_normalized_feature_collection(
        source_feature_collection,
        imported_files,
    )
    warnings.extend(normalization_warnings)
    return ImportArtifacts(
        files=imported_files,
        cleanup_summary=summary,
        source_feature_collection=source_feature_collection,
        feature_collection=feature_collection,
        warnings=warnings,
    )


def read_directory_as_blobs(directory: str | Path) -> list[tuple[str, bytes]]:
    root = Path(directory)
    blobs: list[tuple[str, bytes]] = []
    for file in root.rglob("*"):
        if file.is_file():
            blobs.append((file.name, file.read_bytes()))
    return blobs
