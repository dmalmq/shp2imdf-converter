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
from backend.src.illustrator_importer import _order_layers
from backend.src.illustrator_qgis import build_qgs_project
from backend.src.illustrator_store import CachedConversion

_PREVIEW_TOLERANCE_DIVISOR = 2000.0


@dataclass(slots=True)
class ExportFormats:
    geopackage: bool = True
    shapefile: bool = True
    qgis: bool = True


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
    transform: SimilarityTransform,
    output_crs: str,
    formats: ExportFormats,
) -> tuple[bytes, str]:
    """Apply ``transform``, reproject to ``output_crs`` and zip the outputs."""
    matrix = transform.to_affine_matrix()  # raises for a non-positive scale
    stem = cached.stem
    gpkg_name = f"{stem}_georeferenced.gpkg"
    qgs_name = f"{stem}_georeferenced.qgs"

    buffer = BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        gpkg_path = workdir / gpkg_name
        shapefile_dir = workdir / "shapefiles"
        shapefile_dir.mkdir()

        wrote_any = False
        for spec, gdf in _read_layers(cached):
            if gdf.empty:
                continue
            placed = gdf.copy()
            placed["geometry"] = placed.geometry.affine_transform(matrix)
            placed = placed.set_crs(transform.working_crs, allow_override=True)
            if output_crs != transform.working_crs:
                placed = placed.to_crs(output_crs)

            # The QGIS project references the GeoPackage, so it is written
            # whenever either output is requested.
            if formats.geopackage or formats.qgis:
                placed.to_file(gpkg_path, driver="GPKG", layer=spec["table"])
            if formats.shapefile:
                placed.to_file(
                    shapefile_dir / f"{spec['table']}.shp",
                    driver="ESRI Shapefile",
                    index=False,
                    encoding="utf-8",
                )
            wrote_any = True

        if not wrote_any:
            raise ValueError("The cached conversion contains no geometry to export.")

        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            if formats.geopackage:
                archive.write(gpkg_path, gpkg_name)
            if formats.qgis:
                ordered = _order_layers(cached.written_layers, cached.layer_order)
                archive.writestr(
                    qgs_name,
                    build_qgs_project(
                        ordered,
                        gpkg_filename=gpkg_name,
                        project_name=stem,
                        crs=output_crs,
                    ).encode("utf-8"),
                )
            if formats.shapefile:
                for path in sorted(shapefile_dir.iterdir()):
                    archive.write(path, f"shapefiles/{path.name}")

    return buffer.getvalue(), f"{stem}_georeferenced.zip"
