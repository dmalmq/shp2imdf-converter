"""Deterministic outline matching of one artwork shape against reference polygons.

The selected preview feature is resolved back to its full-fidelity GeoPackage row.
Filled polygons and stroked paths (closed, or closable) are both accepted; a line
is turned into a ring before ranking. Reference geometry is posted as WGS84, or
built from another floor's placed outlines; fitting and residuals run in the
placement's working CRS. Suggestions are ranked and returned; nothing is stored.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any
from typing import Mapping
from typing import Sequence

import geopandas as gpd
from shapely import make_valid
from shapely import to_geojson
from shapely.affinity import affine_transform
from shapely.geometry import LineString
from shapely.geometry import Point
from shapely.geometry import Polygon
from shapely.geometry import mapping
from shapely.geometry import shape
from shapely.ops import linemerge
from shapely.ops import nearest_points
from shapely.ops import unary_union

from backend.src.illustrator_export import ExportFloor
from backend.src.illustrator_export import _floor_mask
from backend.src.illustrator_export import _read_layers
from backend.src.illustrator_outline_match import build_candidates
from backend.src.illustrator_outline_match import match_clusters
from backend.src.illustrator_outline_match import outline_match
from backend.src.illustrator_outline_match import transform_distance
from backend.src.illustrator_georeference import GeoreferenceError
from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_georeference import fit_helmert
from backend.src.illustrator_georeference import residuals
from backend.src.illustrator_georeference import unproject_point
from backend.src.illustrator_store import CachedConversion

_SAMPLE_COUNT = 72
_RESIDUAL_VECTORS = 12
_MAX_MATCHES = 3
_REGION_CANDIDATE_LIMIT = 40
# The user asserted the correspondence by drawing the boxes, so a single match
# is enough and any rotation is legitimate. Scale still needs a sane band: an
# unbounded fit happily maps a stair tread onto a concourse.
_REGION_MIN_SCALE = 0.2
_REGION_MAX_SCALE = 5.0
_SHORTLIST_LIMIT = 48
_OUTLINE_ERROR = "The selected artwork feature is not a usable outline."
_SAME_FLOOR_ERROR = "The reference floor must be different from the selected floor."
_REFERENCE_FLOOR_TRANSFORM_ERROR = "A placement for the reference floor is required."
_PLACEHOLDER_TRANSFORM = SimilarityTransform(
    artwork_anchor=(0.0, 0.0),
    map_anchor=(0.0, 0.0),
    rotation_deg=0.0,
    metres_per_point=1.0,
    working_crs="EPSG:4326",
)


@dataclass(slots=True, frozen=True)
class _Descriptor:
    compactness: float
    elongation: float
    area: float


@dataclass(slots=True)
class _Candidate:
    feature_index: int
    part_index: int
    geom_wgs84: Any
    geom_working: Any
    samples: list[tuple[float, float]]
    descriptor: _Descriptor
    distance: float


@dataclass(slots=True)
class _Fit:
    candidate: _Candidate
    transform: SimilarityTransform
    paired: list[tuple[float, float]]
    boundary_rmse_m: float
    boundary_p95_m: float
    max_residual_m: float
    overlap_iou: float
    score: float
    residual_vectors: list[dict[str, Any]]


def match_shapes(
    cached: CachedConversion,
    *,
    floor_label: str,
    source_table: str,
    source_row: int,
    current: SimilarityTransform,
    scale_locked: bool,
    reference: Mapping[str, Any] | None = None,
    reference_floor_label: str | None = None,
    reference_transform: SimilarityTransform | None = None,
) -> list[dict[str, Any]]:
    """Rank up to three similarity placements of the selected outline.

    Invalid table/row/floor selection raises ``ValueError``. An empty or
    non-polygon reference is a valid empty result. Pass ``reference_floor_label``
    to compare against another floor's full-fidelity outlines instead of a
    posted shapefile collection.
    """
    artwork = _resolve_artwork_polygon(cached, floor_label, source_table, source_row)
    art_samples = _sample_ring(artwork, _SAMPLE_COUNT)
    if len(art_samples) < 2:
        raise ValueError(_OUTLINE_ERROR)
    art_descriptor = _descriptor(artwork)

    if reference_floor_label is not None:
        if reference_floor_label == floor_label:
            raise ValueError(_SAME_FLOOR_ERROR)
        if reference_transform is None:
            raise ValueError(_REFERENCE_FLOOR_TRANSFORM_ERROR)
        reference = reference_collection_for_floor(
            cached, reference_floor_label, reference_transform
        )
    elif reference is None:
        reference = {"type": "FeatureCollection", "features": []}

    fixed_scale = current.metres_per_point if scale_locked else None
    candidates = _collect_candidates(
        reference, current.working_crs, art_descriptor, fixed_scale
    )
    if not candidates:
        return []

    fitted = [
        result
        for candidate in candidates
        if (result := _fit_candidate(art_samples, artwork, candidate, current.working_crs, fixed_scale))
        is not None
    ]
    fitted.sort(key=lambda item: (-item.score, item.candidate.feature_index, item.candidate.part_index))
    return [_suggestion(item, index, fitted) for index, item in enumerate(fitted[:_MAX_MATCHES])]


def match_regions(
    cached: CachedConversion,
    *,
    floor_label: str,
    region: Sequence[float],
    current: SimilarityTransform,
    scale_locked: bool,
    reference_floor_label: str,
    reference_transform: SimilarityTransform,
    reference_region: Sequence[float],
) -> list[dict[str, Any]]:
    """Rank similarity placements that map a boxed active-floor area onto a boxed reference floor."""
    _floor_assignment(cached, floor_label)
    if reference_floor_label == floor_label:
        raise ValueError(_SAME_FLOOR_ERROR)
    _floor_assignment(cached, reference_floor_label)

    sources = build_candidates(
        _region_outlines(cached, floor_label, region),
        minimum_area=0.0,
        limit=_REGION_CANDIDATE_LIMIT,
    )
    targets = build_candidates(
        _region_outlines(cached, reference_floor_label, reference_region),
        minimum_area=0.0,
        limit=_REGION_CANDIDATE_LIMIT,
    )
    if not sources or not targets:
        return []

    minx, miny, maxx, maxy = (float(value) for value in region)
    sheet = (max(maxx - minx, 1.0), max(maxy - miny, 1.0))
    center = ((minx + maxx) / 2.0, (miny + maxy) / 2.0)
    fixed_scale = (
        current.metres_per_point / reference_transform.metres_per_point
        if scale_locked
        else None
    )
    matches = [
        match
        for source in sources
        for target in targets
        if (
            match := outline_match(
                source,
                target,
                sheet,
                fixed_scale=fixed_scale,
                center=center,
                min_scale=_REGION_MIN_SCALE,
                max_scale=_REGION_MAX_SCALE,
            )
        )
        is not None
    ]
    clusters = match_clusters(matches, sheet)
    clusters.sort(
        key=lambda cluster: (
            -len(cluster),
            # Area-weighted, so a cluster of substantial outlines outranks an
            # equally sized cluster of incidental fragments.
            -sum(item.weight for item in cluster),
            -_median([item.overlap_iou for item in cluster]),
            _median([item.normalized_rmse for item in cluster]),
        )
    )
    ranked = [
        _region_suggestion(
            cluster,
            sources,
            targets,
            current,
            reference_transform,
            sheet,
            scale_locked,
        )
        for cluster in clusters
    ]
    return [
        _suggestion_rank(item, index, ranked)
        for index, item in enumerate(ranked[:_MAX_MATCHES])
    ]


def _region_outlines(
    cached: CachedConversion, floor_label: str, region: Sequence[float]
) -> list:
    stored = _floor_assignment(cached, floor_label)
    export_floor = ExportFloor(
        label=floor_label,
        transform=_PLACEHOLDER_TRANSFORM,
        region=stored.get("box"),
        layer_names=stored.get("layer_names"),
        pages=stored.get("pages"),
    )
    minx, miny, maxx, maxy = (float(value) for value in region)
    outlines = []
    for _spec, frame in _read_layers(cached):
        if frame.empty:
            continue
        subset = frame[_floor_mask(frame, export_floor)]
        for geom in subset.geometry:
            try:
                outline = _as_outline_polygon(geom)
            except ValueError:
                continue
            centroid = outline.centroid
            if minx <= centroid.x <= maxx and miny <= centroid.y <= maxy:
                outlines.append(outline)
    return outlines


def _region_suggestion(
    cluster,
    sources,
    targets,
    current: SimilarityTransform,
    reference_transform: SimilarityTransform,
    sheet: tuple[float, float],
    scale_locked: bool,
) -> dict[str, Any]:
    medoid = min(
        cluster,
        key=lambda candidate: sum(
            transform_distance(candidate, other, sheet) for other in cluster
        ),
    )
    source = sources[medoid.source_index]
    target = targets[medoid.target_index]
    composed = _compose_region_transform(
        current, reference_transform, medoid, scale_locked
    )
    metres = composed.metres_per_point
    moved = make_valid(affine_transform(source.geom, medoid.matrix))
    if moved.geom_type == "MultiPolygon":
        moved = max(moved.geoms, key=lambda part: part.area)
    moved_samples = [_apply_matrix(medoid.matrix, point) for point in source.samples]
    distances = (
        _symmetric_distances(moved_samples, list(target.samples), moved, target.geom)
        if moved.geom_type == "Polygon"
        else []
    )
    median_overlap = _median([item.overlap_iou for item in cluster])
    boundary_rmse_m = _rmse(distances) * metres
    art_placed = [
        _apply_matrix(composed.to_affine_matrix(), point) for point in source.samples
    ]
    ref_placed = affine_transform(target.geom, reference_transform.to_affine_matrix())
    unioned = unary_union([targets[item.target_index].geom for item in cluster])
    placed_union = make_valid(
        affine_transform(unioned, reference_transform.to_affine_matrix())
    )
    wgs = _to_wgs84(placed_union, reference_transform.working_crs)
    return {
        "rank": 0,
        "score": median_overlap / (1.0 + boundary_rmse_m),
        "relative_gap": None,
        "reference_feature_index": medoid.target_index,
        "reference_part_index": 0,
        "transform": {
            "artwork_anchor": [composed.artwork_anchor[0], composed.artwork_anchor[1]],
            "map_anchor": [composed.map_anchor[0], composed.map_anchor[1]],
            "rotation_deg": composed.rotation_deg,
            "metres_per_point": composed.metres_per_point,
            "working_crs": composed.working_crs,
        },
        "boundary_rmse_m": boundary_rmse_m,
        "boundary_p95_m": _percentile(distances, 95.0) * metres,
        "max_residual_m": (max(distances) if distances else 0.0) * metres,
        "overlap_iou": median_overlap,
        "reference_geometry": json.loads(to_geojson(wgs)),
        "residual_vectors": _residual_vectors(
            art_placed, ref_placed, composed.working_crs
        ),
    }


def _compose_region_transform(
    current: SimilarityTransform,
    reference_transform: SimilarityTransform,
    match,
    scale_locked: bool,
) -> SimilarityTransform:
    metres = (
        current.metres_per_point
        if scale_locked
        else reference_transform.metres_per_point * match.scale
    )
    rotation = (
        reference_transform.rotation_deg + match.rotation_deg + 180.0
    ) % 360.0 - 180.0
    ax, ay = current.artwork_anchor
    a, b, d, e, xoff, yoff = match.matrix
    mapped_x = a * ax + b * ay + xoff
    mapped_y = d * ax + e * ay + yoff
    ra, rb, rd, re, rxoff, ryoff = reference_transform.to_affine_matrix()
    east = ra * mapped_x + rb * mapped_y + rxoff
    north = rd * mapped_x + re * mapped_y + ryoff
    return SimilarityTransform(
        artwork_anchor=current.artwork_anchor,
        map_anchor=unproject_point(east, north, reference_transform.working_crs),
        rotation_deg=rotation,
        metres_per_point=metres,
        working_crs=reference_transform.working_crs,
    )


def _suggestion_rank(item: dict[str, Any], index: int, ranked: list[dict[str, Any]]) -> dict[str, Any]:
    nxt = ranked[index + 1] if index + 1 < len(ranked) else None
    relative_gap = None
    if nxt is not None and item["score"] > 0:
        relative_gap = (item["score"] - nxt["score"]) / item["score"]
    return {**item, "rank": index + 1, "relative_gap": relative_gap}


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _resolve_artwork_polygon(
    cached: CachedConversion, floor_label: str, source_table: str, source_row: int
):
    stored = _floor_assignment(cached, floor_label)
    layers = _read_layers(cached)
    found = next(((spec, frame) for spec, frame in layers if spec["table"] == source_table), None)
    if found is None:
        raise ValueError(f"Unknown source table: {source_table}.")
    _spec, frame = found
    if source_row < 0 or source_row >= len(frame):
        raise ValueError(f"Unknown source row: {source_row}.")
    row = frame.iloc[[source_row]]
    export_floor = ExportFloor(
        label=floor_label,
        transform=_PLACEHOLDER_TRANSFORM,
        region=stored.get("box"),
        layer_names=stored.get("layer_names"),
        pages=stored.get("pages"),
    )
    if not bool(_floor_mask(row, export_floor).iloc[0]):
        raise ValueError(f"The selected outline is not assigned to floor '{floor_label}'.")
    geom = row.geometry.iloc[0]
    if geom is None or geom.is_empty:
        raise ValueError(_OUTLINE_ERROR)
    return _as_outline_polygon(geom)


def _as_outline_polygon(geom):
    """Turn a filled polygon or a stroked path into the ring used for fitting."""
    if geom.geom_type in {"Polygon", "MultiPolygon"}:
        geom = make_valid(geom)
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda part: part.area)
        if geom.geom_type == "Polygon" and geom.area > 0:
            return geom
        raise ValueError(_OUTLINE_ERROR)
    polygon = _polygon_from_line(_as_outline_line(geom))
    if polygon is None or polygon.area <= 0:
        raise ValueError(_OUTLINE_ERROR)
    return polygon


def _as_outline_line(geom) -> LineString:
    if geom.geom_type == "LineString":
        return geom
    if geom.geom_type == "LinearRing":
        return LineString(geom.coords)
    if geom.geom_type == "MultiLineString":
        merged = linemerge(geom)
        if merged.geom_type == "MultiLineString":
            return max(merged.geoms, key=lambda part: part.length)
        return merged
    raise ValueError(_OUTLINE_ERROR)


def _polygon_from_line(line: LineString) -> Polygon | None:
    cleaned: list[tuple[float, float]] = []
    for x, y in line.coords:
        point = (float(x), float(y))
        if not cleaned or point != cleaned[-1]:
            cleaned.append(point)
    if len(cleaned) < 3:
        return None
    if cleaned[0] != cleaned[-1]:
        cleaned.append(cleaned[0])
    if len(cleaned) < 4:
        return None
    polygon = make_valid(Polygon(cleaned))
    if polygon.geom_type == "MultiPolygon":
        polygon = max(polygon.geoms, key=lambda part: part.area)
    if polygon.geom_type != "Polygon":
        return None
    return polygon


def _floor_assignment(cached: CachedConversion, floor_label: str) -> dict:
    if not cached.floors:
        raise ValueError("No floor assignment is stored; assign floors before matching.")
    stored = next((floor for floor in cached.floors if floor.get("label") == floor_label), None)
    if stored is None:
        raise ValueError(f"Unknown floor label: {floor_label}.")
    return stored


def reference_collection_for_floor(
    cached: CachedConversion, floor_label: str, transform: SimilarityTransform
) -> dict[str, Any]:
    """Place that floor's usable outlines into a WGS84 FeatureCollection."""
    stored = _floor_assignment(cached, floor_label)
    export_floor = ExportFloor(
        label=floor_label,
        transform=_PLACEHOLDER_TRANSFORM,
        region=stored.get("box"),
        layer_names=stored.get("layer_names"),
        pages=stored.get("pages"),
    )
    features: list[dict[str, Any]] = []
    for _spec, frame in _read_layers(cached):
        if frame.empty:
            continue
        subset = frame[_floor_mask(frame, export_floor)]
        for geom in subset.geometry:
            outline = _reference_outline(geom)
            if outline is None:
                continue
            placed = affine_transform(outline, transform.to_affine_matrix())
            wgs = _to_wgs84(placed, transform.working_crs)
            if wgs is None or wgs.is_empty:
                continue
            features.append({"type": "Feature", "properties": {}, "geometry": mapping(wgs)})
    return {"type": "FeatureCollection", "features": features}


def _reference_outline(geom):
    """Turn a floor feature into a polygon/multipolygon the ranker can use."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in {"Polygon", "MultiPolygon"}:
        geom = make_valid(geom)
        if geom.geom_type in {"Polygon", "MultiPolygon"} and geom.area > 0:
            return geom
        return None
    try:
        polygon = _polygon_from_line(_as_outline_line(geom))
    except ValueError:
        return None
    if polygon is None or polygon.area <= 0:
        return None
    return polygon


def _to_wgs84(geom, crs: str):
    return gpd.GeoSeries([geom], crs=crs).to_crs("EPSG:4326").iloc[0]


def _collect_candidates(
    reference: Mapping[str, Any],
    working_crs: str,
    art_descriptor: _Descriptor,
    fixed_scale: float | None,
) -> list[_Candidate]:
    collected: list[_Candidate] = []
    for feature_index, part_index, geom in _iter_reference_parts(reference):
        working = _project_wgs84(geom, working_crs)
        if working is None or working.is_empty or working.geom_type != "Polygon" or working.area <= 0:
            continue
        samples = _sample_ring(working, _SAMPLE_COUNT)
        if len(samples) < 2:
            continue
        descriptor = _descriptor(working)
        collected.append(
            _Candidate(
                feature_index=feature_index,
                part_index=part_index,
                geom_wgs84=geom,
                geom_working=working,
                samples=samples,
                descriptor=descriptor,
                distance=_descriptor_distance(art_descriptor, descriptor, fixed_scale),
            )
        )
    collected.sort(key=lambda item: (item.distance, item.feature_index, item.part_index))
    return collected[:_SHORTLIST_LIMIT]


def _iter_reference_parts(reference: Mapping[str, Any]):
    features = reference.get("features") or []
    for feature_index, feature in enumerate(features):
        if not isinstance(feature, dict):
            continue
        raw = feature.get("geometry")
        if not raw:
            continue
        try:
            geom = make_valid(shape(raw))
        except (TypeError, ValueError, AttributeError):
            continue
        if geom.is_empty:
            continue
        if geom.geom_type == "Polygon":
            yield feature_index, 0, geom
        elif geom.geom_type == "MultiPolygon":
            for part_index, part in enumerate(geom.geoms):
                if part.is_empty or part.geom_type != "Polygon":
                    continue
                yield feature_index, part_index, part


def _project_wgs84(geom, crs: str):
    projected = gpd.GeoSeries([geom], crs="EPSG:4326").to_crs(crs).iloc[0]
    projected = make_valid(projected)
    if projected.geom_type == "MultiPolygon":
        projected = max(projected.geoms, key=lambda part: part.area)
    return projected


def _descriptor(geom) -> _Descriptor:
    area = float(geom.area)
    perimeter = float(geom.length)
    compactness = (4.0 * math.pi * area / (perimeter * perimeter)) if perimeter > 0 else 0.0
    rect = geom.minimum_rotated_rectangle
    coords = list(rect.exterior.coords)
    width = math.dist(coords[0], coords[1]) if len(coords) >= 2 else 0.0
    height = math.dist(coords[1], coords[2]) if len(coords) >= 3 else 0.0
    short, long = (width, height) if width <= height else (height, width)
    elongation = (short / long) if long > 0 else 1.0
    return _Descriptor(compactness=compactness, elongation=elongation, area=area)


def _descriptor_distance(art: _Descriptor, ref: _Descriptor, scale: float | None) -> float:
    distance = (art.compactness - ref.compactness) ** 2 + (art.elongation - ref.elongation) ** 2
    if scale is not None:
        predicted = art.area * scale * scale
        denom = max(predicted, ref.area, 1e-9)
        distance += ((ref.area - predicted) / denom) ** 2
    return distance


def _sample_ring(geom, count: int) -> list[tuple[float, float]]:
    ring = LineString(geom.exterior.coords)
    length = float(ring.length)
    if length <= 0 or count < 2:
        return []
    return [
        (float(point.x), float(point.y))
        for point in (ring.interpolate(index * length / count) for index in range(count))
    ]


def _fit_candidate(
    art_samples: list[tuple[float, float]],
    artwork,
    candidate: _Candidate,
    working_crs: str,
    fixed_scale: float | None,
) -> _Fit | None:
    best: tuple[float, SimilarityTransform, list[tuple[float, float]]] | None = None
    n = len(art_samples)
    for reverse in (False, True):
        sequence = list(reversed(candidate.samples)) if reverse else candidate.samples
        for start in range(n):
            paired = [sequence[(start + index) % n] for index in range(n)]
            try:
                map_points = [unproject_point(east, north, working_crs) for east, north in paired]
                transform = fit_helmert(art_samples, map_points, working_crs, fixed_scale)
                _distances, rmse = residuals(transform, art_samples, map_points)
            except GeoreferenceError:
                continue
            if best is None or rmse < best[0]:
                best = (rmse, transform, paired)
    if best is None:
        return None
    _, transform, paired = best
    matrix = transform.to_affine_matrix()
    placed = make_valid(affine_transform(artwork, matrix))
    if placed.is_empty:
        return None
    if placed.geom_type == "MultiPolygon":
        placed = max(placed.geoms, key=lambda part: part.area)
    if placed.geom_type != "Polygon":
        return None

    art_placed_samples = [_apply_matrix(matrix, point) for point in art_samples]
    distances = _symmetric_distances(art_placed_samples, paired, placed, candidate.geom_working)
    rmse = _rmse(distances)
    p95 = _percentile(distances, 95.0)
    max_residual = max(distances) if distances else 0.0
    iou = _iou(placed, candidate.geom_working)

    score = iou / (1.0 + rmse)
    return _Fit(
        candidate=candidate,
        transform=transform,
        paired=paired,
        boundary_rmse_m=rmse,
        boundary_p95_m=p95,
        max_residual_m=max_residual,
        overlap_iou=iou,
        score=score,
        residual_vectors=_residual_vectors(art_placed_samples, candidate.geom_working, working_crs),
    )


def _suggestion(item: _Fit, index: int, fitted: list[_Fit]) -> dict[str, Any]:
    nxt = fitted[index + 1] if index + 1 < len(fitted) else None
    relative_gap = None
    if nxt is not None and item.score > 0:
        relative_gap = (item.score - nxt.score) / item.score
    transform = item.transform
    return {
        "rank": index + 1,
        "score": item.score,
        "relative_gap": relative_gap,
        "reference_feature_index": item.candidate.feature_index,
        "reference_part_index": item.candidate.part_index,
        "transform": {
            "artwork_anchor": [transform.artwork_anchor[0], transform.artwork_anchor[1]],
            "map_anchor": [transform.map_anchor[0], transform.map_anchor[1]],
            "rotation_deg": transform.rotation_deg,
            "metres_per_point": transform.metres_per_point,
            "working_crs": transform.working_crs,
        },
        "boundary_rmse_m": item.boundary_rmse_m,
        "boundary_p95_m": item.boundary_p95_m,
        "max_residual_m": item.max_residual_m,
        "overlap_iou": item.overlap_iou,
        "reference_geometry": json.loads(to_geojson(item.candidate.geom_wgs84)),
        "residual_vectors": item.residual_vectors,
    }


def _apply_matrix(matrix: list[float], point: tuple[float, float]) -> tuple[float, float]:
    a, b, d, e, xoff, yoff = matrix
    x, y = point
    return (a * x + b * y + xoff, d * x + e * y + yoff)


def _symmetric_distances(
    art_placed: list[tuple[float, float]],
    paired: list[tuple[float, float]],
    placed,
    reference,
) -> list[float]:
    art_boundary = placed.boundary
    ref_boundary = reference.boundary
    distances: list[float] = []
    for x, y in art_placed:
        distances.append(float(Point(x, y).distance(ref_boundary)))
    for x, y in paired:
        distances.append(float(Point(x, y).distance(art_boundary)))
    return distances


def _residual_vectors(
    art_placed: list[tuple[float, float]],
    reference,
    working_crs: str,
) -> list[dict[str, Any]]:
    boundary = reference.boundary
    stride = max(1, len(art_placed) // _RESIDUAL_VECTORS)
    vectors: list[dict[str, Any]] = []
    for x, y in art_placed[::stride][:_RESIDUAL_VECTORS]:
        point = Point(x, y)
        nearest = nearest_points(point, boundary)[1]
        art_ll = unproject_point(x, y, working_crs)
        ref_ll = unproject_point(float(nearest.x), float(nearest.y), working_crs)
        vectors.append(
            {
                "artwork": [art_ll[0], art_ll[1]],
                "reference": [ref_ll[0], ref_ll[1]],
                "distance_m": float(point.distance(nearest)),
            }
        )
    return vectors


def _rmse(distances: list[float]) -> float:
    if not distances:
        return 0.0
    return math.sqrt(sum(value * value for value in distances) / len(distances))


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    lo = int(math.floor(rank))
    hi = min(len(ordered) - 1, int(math.ceil(rank)))
    if lo == hi:
        return ordered[lo]
    frac = rank - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


def _iou(left, right) -> float:
    if left.is_empty or right.is_empty:
        return 0.0
    try:
        intersection = left.intersection(right)
        union = left.union(right)
    except (TypeError, ValueError):
        return 0.0
    union_area = float(union.area)
    if union_area <= 0:
        return 0.0
    return float(intersection.area) / union_area
