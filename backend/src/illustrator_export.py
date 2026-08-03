"""Preview payloads and georeferenced export bundles.

Preview geometry stays in artwork points and is decimated so dragging a
station-sized plan is responsive; export re-reads the same cached GeoPackage at
full fidelity, applies the placement and reprojects to the requested CRS.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import geopandas as gpd

from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_importer import _order_layers, _sanitize_layer_name
from backend.src.illustrator_qgis import QgisLayerSpec, build_qgs_project
from backend.src.illustrator_store import CachedConversion

_PREVIEW_TOLERANCE_DIVISOR = 2000.0


class FloorExportError(RuntimeError):
    """Raised when an export request does not match the stored assignment."""


@dataclass(slots=True)
class ExportFloor:
    """One floor of an export: a region in artwork points plus its placement."""

    label: str
    transform: SimilarityTransform
    region: list[float]
    layer_names: list[str] | None


@dataclass(slots=True)
class ExportFormats:
    geopackage: bool = True
    shapefile: bool = True
    qgis: bool = True


def _centroid_inside(geometry, region: list[float]) -> bool:
    if geometry is None or geometry.is_empty:
        return False
    minx, miny, maxx, maxy = region
    cx, cy = geometry.centroid.x, geometry.centroid.y
    return minx <= cx <= maxx and miny <= cy <= maxy


def _matches_floor(row, region: list[float], layer_names: list[str] | None) -> bool:
    if not _centroid_inside(row.geometry, region):
        return False
    return layer_names is None or row["ai_layer"] in layer_names


def _report_row(report_floors: list[dict], label: str, table: str, count: int) -> None:
    entry = next((f for f in report_floors if f["label"] == label), None)
    if entry is None:
        entry = {"label": label, "feature_count": 0, "tables": []}
        report_floors.append(entry)
    entry["feature_count"] += count
    entry["tables"].append(table)


def _group_by_floor(
    specs: list[tuple[str, QgisLayerSpec]],
) -> list[tuple[str, list[QgisLayerSpec]]]:
    groups: list[tuple[str, list[QgisLayerSpec]]] = []
    for label, spec in specs:
        if not groups or groups[-1][0] != label:
            groups.append((label, []))
        groups[-1][1].append(spec)
    return groups


def _read_layers(cached: CachedConversion) -> list[tuple[dict[str, str], gpd.GeoDataFrame]]:
    return [
        (spec, gpd.read_file(cached.gpkg_path, layer=spec["table"]))
        for spec in cached.written_layers
    ]


def _diagonal_of(geometry) -> float:
    if geometry is None or geometry.is_empty:
        return 0.0
    minx, miny, maxx, maxy = geometry.bounds
    return ((maxx - minx) ** 2 + (maxy - miny) ** 2) ** 0.5


def build_preview(
    cached: CachedConversion, tolerance_divisor: float = _PREVIEW_TOLERANCE_DIVISOR
) -> dict:
    """Artwork-space GeoJSON for on-map preview, decimated for interactivity."""
    layers = _read_layers(cached)

    bounds = None
    for _spec, gdf in layers:
        if gdf.empty:
            continue
        minx, miny, maxx, maxy = gdf.total_bounds
        bounds = (
            (minx, miny, maxx, maxy)
            if bounds is None
            else (
                min(bounds[0], minx),
                min(bounds[1], miny),
                max(bounds[2], maxx),
                max(bounds[3], maxy),
            )
        )
    if bounds is None:
        bounds = (0.0, 0.0, 1.0, 1.0)

    diagonal = ((bounds[2] - bounds[0]) ** 2 + (bounds[3] - bounds[1]) ** 2) ** 0.5
    tolerance = diagonal / tolerance_divisor if diagonal > 0 else 0.0

    features: list[dict] = []
    total = 0
    summaries: list[dict] = []
    for spec, gdf in layers:
        total += len(gdf)
        summaries.append({**spec, "feature_count": int(len(gdf))})
        if gdf.empty:
            continue
        simplified = gdf.copy()
        if tolerance > 0:
            simplified["geometry"] = simplified.geometry.simplify(
                tolerance, preserve_topology=True
            )
            simplified = simplified[simplified.geometry.apply(_diagonal_of) >= tolerance]
        if simplified.empty:
            continue
        features.extend(json.loads(simplified.to_json(na="null"))["features"])

    return {
        "artwork_bounds": [float(value) for value in bounds],
        "preview": {"type": "FeatureCollection", "features": features},
        "preview_features": len(features),
        "total_features": int(total),
        "layers": summaries,
    }


def build_georeferenced_bundle(
    cached: CachedConversion,
    floors: list[ExportFloor],
    output_crs: str,
    formats: ExportFormats,
) -> tuple[bytes, str]:
    """Apply each floor's placement, reproject and zip the outputs.

    Membership is re-computed from the full-fidelity geometry by
    ``centroid ∈ region`` (plus the layer restriction). Features in no floor
    are dropped and reported in ``export_report.json``. Tables are named
    ``{floor}_{layer}``; the ``floor`` attribute records membership.
    """
    if not floors:
        raise FloorExportError("At least one floor is required for export.")
    stem = cached.stem
    gpkg_name = f"{stem}_georeferenced.gpkg"
    qgs_name = f"{stem}_georeferenced.qgs"

    buffer = BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        gpkg_path = workdir / gpkg_name
        shapefile_dir = workdir / "shapefiles"
        shapefile_dir.mkdir()

        report_floors: list[dict] = []
        qgs_specs: list[tuple[str, QgisLayerSpec]] = []
        warnings: list[str] = []
        unassigned_total = 0
        wrote_any = False
        for spec, gdf in _read_layers(cached):
            if gdf.empty:
                continue
            remaining = gdf
            layer_assigned = 0
            for floor in floors:
                mask = remaining.apply(
                    _matches_floor, axis=1, region=floor.region, layer_names=floor.layer_names
                )
                subset = remaining[mask]
                remaining = remaining[~mask]
                if subset.empty:
                    continue
                placed = subset.copy()
                placed["geometry"] = placed.geometry.affine_transform(
                    floor.transform.to_affine_matrix()  # raises for non-positive scale
                )
                placed = placed.set_crs(floor.transform.working_crs, allow_override=True)
                placed["floor"] = floor.label
                if output_crs != floor.transform.working_crs:
                    placed = placed.to_crs(output_crs)
                table = f"{_sanitize_layer_name(floor.label, set())}_{spec['table']}"
                if formats.geopackage or formats.qgis:
                    placed.to_file(gpkg_path, driver="GPKG", layer=table)
                if formats.shapefile:
                    placed.to_file(
                        shapefile_dir / f"{table}.shp",
                        driver="ESRI Shapefile",
                        index=False,
                        encoding="utf-8",
                    )
                layer_assigned += len(subset)
                wrote_any = True
                _report_row(report_floors, floor.label, table, len(subset))
                qgs_specs.append(
                    (
                        floor.label,
                        QgisLayerSpec(
                            table=table,
                            display_name=f"{floor.label} / {spec['ai_layer']}",
                            role=spec["role"],
                        ),
                    )
                )
            if layer_assigned == 0:
                warnings.append(f"Layer '{spec['ai_layer']}' was not assigned to any floor.")
            unassigned_total += len(remaining)

        if not wrote_any:
            raise ValueError("The cached conversion contains no geometry to export.")

        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "export_report.json",
                json.dumps(
                    {
                        "floors": report_floors,
                        "unassigned_count": unassigned_total,
                        "warnings": warnings,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
            if formats.geopackage:
                archive.write(gpkg_path, gpkg_name)
            if formats.qgis:
                archive.writestr(
                    qgs_name,
                    build_qgs_project(
                        [],
                        gpkg_filename=gpkg_name,
                        project_name=stem,
                        crs=output_crs,
                        layer_groups=_group_by_floor(qgs_specs),
                    ).encode("utf-8"),
                )
            if formats.shapefile:
                for path in sorted(shapefile_dir.iterdir()):
                    archive.write(path, f"shapefiles/{path.name}")

    return buffer.getvalue(), f"{stem}_georeferenced.zip"


def compute_assignment_summary(
    cached: CachedConversion, floors: list[ExportFloor]
) -> tuple[list[dict], int]:
    """Per-floor feature counts, artwork bounds and layer counts; unassigned total."""
    per_floor: list[dict] = []
    unassigned = 0
    for spec, gdf in _read_layers(cached):
        if gdf.empty:
            continue
        remaining = gdf
        for floor in floors:
            mask = remaining.apply(
                _matches_floor, axis=1, region=floor.region, layer_names=floor.layer_names
            )
            subset = remaining[mask]
            remaining = remaining[~mask]
            if subset.empty:
                continue
            entry = next((f for f in per_floor if f["label"] == floor.label), None)
            if entry is None:
                entry = {"label": floor.label, "feature_count": 0, "artwork_bounds": None, "layer_counts": []}
                per_floor.append(entry)
            entry["feature_count"] += len(subset)
            minx, miny, maxx, maxy = subset.total_bounds
            entry["artwork_bounds"] = (
                [float(minx), float(miny), float(maxx), float(maxy)]
                if entry["artwork_bounds"] is None
                else [
                    min(entry["artwork_bounds"][0], float(minx)),
                    min(entry["artwork_bounds"][1], float(miny)),
                    max(entry["artwork_bounds"][2], float(maxx)),
                    max(entry["artwork_bounds"][3], float(maxy)),
                ]
            )
            row = next((r for r in entry["layer_counts"] if r["table"] == spec["table"]), None)
            if row is None:
                row = {"table": spec["table"], "ai_layer": spec["ai_layer"], "count": 0}
                entry["layer_counts"].append(row)
            row["count"] += len(subset)
        unassigned += len(remaining)
    for entry in per_floor:
        entry["artwork_bounds"] = entry["artwork_bounds"] or [0.0, 0.0, 1.0, 1.0]
    return per_floor, unassigned
