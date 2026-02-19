"""Shapefile import pipeline for Phase 1."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import tempfile
from typing import Any, Sequence
from uuid import uuid4
import zipfile

import geopandas as gpd
import pandas as pd
from pyproj import CRS
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
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


@dataclass(slots=True)
class ImportArtifacts:
    files: list[ImportedFile]
    cleanup_summary: CleanupSummary
    feature_collection: dict[str, Any]
    warnings: list[str]


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


def _group_by_stem(file_blobs: Sequence[tuple[str, bytes]]) -> dict[str, dict[str, bytes]]:
    grouped: dict[str, dict[str, bytes]] = {}
    for name, content in file_blobs:
        suffix = Path(name).suffix.lower()
        if suffix not in SUPPORTED_SHAPEFILE_EXTENSIONS:
            continue
        stem = Path(name).stem
        grouped.setdefault(stem, {})[suffix] = content
    return grouped


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


def _clean_geometry(geom: Any, summary: CleanupSummary, precision: int = 7) -> list[Any]:
    if geom is None:
        summary.empty_features_dropped += 1
        return []

    fixed = make_valid(geom)
    normalized = _normalize_geometry(fixed, summary)

    candidates: list[Any]
    if isinstance(normalized, MultiPolygon):
        candidates = list(normalized.geoms)
        summary.multipolygons_exploded += max(0, len(candidates) - 1)
    else:
        candidates = [normalized]

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

    for _, row in gdf.iterrows():
        metadata = {column: row[column] for column in non_geom_columns}
        cleaned_geometries = _clean_geometry(row[geometry_column], summary)
        for geometry in cleaned_geometries:
            payload = dict(metadata)
            payload[geometry_column] = geometry
            cleaned_rows.append(payload)

    if not cleaned_rows:
        return gpd.GeoDataFrame(columns=gdf.columns, geometry=geometry_column, crs=gdf.crs)

    return gpd.GeoDataFrame(cleaned_rows, geometry=geometry_column, crs=gdf.crs)


def _extract_feature_rows(stem: str, gdf: gpd.GeoDataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    geometry_column = gdf.geometry.name
    data_columns = [column for column in gdf.columns if column != geometry_column]
    for _, row in gdf.iterrows():
        geometry = row[geometry_column]
        if geometry is None or geometry.is_empty:
            continue
        metadata = {column: _sanitize_value(row[column]) for column in data_columns}
        rows.append(
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "source",
                "geometry": mapping(geometry),
                "properties": {
                    "source_file": stem,
                    "status": "mapped",
                    "issues": [],
                    "metadata": metadata,
                },
            }
        )
    return rows


def _read_shapefile_from_group(stem: str, grouped_files: dict[str, bytes]) -> tuple[gpd.GeoDataFrame, list[str], str | None]:
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

    crs_detected = str(gdf.crs) if gdf.crs else None
    if gdf.crs:
        try:
            parsed = CRS.from_user_input(gdf.crs)
            crs_detected = parsed.to_string()
        except Exception:
            pass
        if gdf.crs.to_string() != "EPSG:4326":
            gdf = gdf.to_crs(epsg=4326)
    return gdf, warnings, crs_detected


def import_file_blobs(
    file_blobs: Sequence[tuple[str, bytes]],
    filename_keywords_path: str | Path,
) -> ImportArtifacts:
    if not file_blobs:
        raise ValueError("No files provided.")

    expanded = _expand_archives(file_blobs)
    grouped = _group_by_stem(expanded)
    if not grouped:
        raise ValueError("No shapefile components found in upload.")

    summary = CleanupSummary()
    warnings: list[str] = []
    imported_files: list[ImportedFile] = []
    features: list[dict[str, Any]] = []

    for stem, files in sorted(grouped.items()):
        if ".shp" not in files:
            continue

        gdf, file_warnings, crs_detected = _read_shapefile_from_group(stem, files)
        warnings.extend(file_warnings)
        cleaned = _clean_geodataframe(gdf, summary)
        geometry_type = _infer_geometry_type(cleaned)
        columns = [column for column in cleaned.columns if column != cleaned.geometry.name]

        imported_files.append(
            ImportedFile(
                stem=stem,
                geometry_type=geometry_type,
                feature_count=int(len(cleaned)),
                attribute_columns=columns,
                crs_detected=crs_detected,
                warnings=file_warnings,
            )
        )
        features.extend(_extract_feature_rows(stem, cleaned))

    keyword_map = load_keyword_map(filename_keywords_path)
    imported_files = detect_files(imported_files, keyword_map, preserve_manual_levels=False)

    feature_collection = {"type": "FeatureCollection", "features": features}
    return ImportArtifacts(
        files=imported_files,
        cleanup_summary=summary,
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
