"""Geometry-generic outline similarity matching.

Both import-time page alignment and interactive region matching fit closed
polygons by a no-reflection similarity. Candidate construction (open-stroke
rules, sheet-frame filters) stays with each caller; this module owns
descriptors, sampling, fitting, overlap, and hypothesis clustering.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any
from typing import Sequence

from shapely import make_valid
from shapely.affinity import affine_transform
from shapely.geometry import LineString

_SAMPLE_COUNT = 48
_CLUSTER_ROTATION_TOLERANCE_DEG = 0.25
_CLUSTER_SCALE_TOLERANCE = 0.005
_MATCH_MIN_IOU = 0.85
_MATCH_MAX_NORMALIZED_RMSE = 0.05


@dataclass(slots=True, frozen=True)
class OutlineCandidate:
    """One closed outline considered for a similarity vote."""

    index: int
    geom: Any
    area: float
    compactness: float
    elongation: float
    samples: tuple[tuple[float, float], ...]


@dataclass(slots=True, frozen=True)
class OutlineMatch:
    """One independently fitted source/target outline pair."""

    source_index: int
    target_index: int
    matrix: tuple[float, float, float, float, float, float]
    scale: float
    rotation_deg: float
    center_shift: tuple[float, float]
    overlap_iou: float
    normalized_rmse: float
    weight: float


def outline_descriptor(polygon: Any) -> tuple[float, float]:
    area = float(polygon.area)
    perimeter = float(polygon.length)
    compactness = 4.0 * math.pi * area / (perimeter * perimeter) if perimeter > 0 else 0.0
    rectangle = polygon.minimum_rotated_rectangle
    coords = list(rectangle.exterior.coords)
    sides = [math.dist(coords[index], coords[index + 1]) for index in range(4)]
    short, long = min(sides), max(sides)
    return compactness, short / long if long > 0 else 1.0


def sample_outline(
    polygon: Any, count: int = _SAMPLE_COUNT
) -> tuple[tuple[float, float], ...]:
    ring = LineString(polygon.exterior.coords)
    length = float(ring.length)
    if length <= 0:
        return ()
    return tuple(
        (float(point.x), float(point.y))
        for point in (
            ring.interpolate(index * length / count) for index in range(count)
        )
    )


def build_candidates(
    polygons: Sequence[Any], *, minimum_area: float, limit: int
) -> list[OutlineCandidate]:
    """Unique polygons above ``minimum_area``, largest first, capped and indexed."""
    found: list[OutlineCandidate] = []
    seen: set[bytes] = set()
    for polygon in polygons:
        if polygon is None or polygon.area < minimum_area:
            continue
        signature = polygon.normalize().wkb
        if signature in seen:
            continue
        seen.add(signature)
        compactness, elongation = outline_descriptor(polygon)
        samples = sample_outline(polygon)
        if not samples:
            continue
        found.append(
            OutlineCandidate(
                index=len(found),
                geom=polygon,
                area=float(polygon.area),
                compactness=compactness,
                elongation=elongation,
                samples=samples,
            )
        )
    found.sort(key=lambda item: -item.area)
    return [
        OutlineCandidate(
            index=index,
            geom=item.geom,
            area=item.area,
            compactness=item.compactness,
            elongation=item.elongation,
            samples=item.samples,
        )
        for index, item in enumerate(found[:limit])
    ]


def fit_similarity(
    source_points: Sequence[tuple[float, float]],
    target_points: Sequence[tuple[float, float]],
    fixed_scale: float | None = None,
) -> tuple[tuple[float, float, float, float, float, float], float] | None:
    """Complex-plane least squares; ``fixed_scale`` keeps that rotation, forces scale."""
    count = len(source_points)
    if count < 2 or len(target_points) != count:
        return None
    source_x = sum(point[0] for point in source_points) / count
    source_y = sum(point[1] for point in source_points) / count
    target_x = sum(point[0] for point in target_points) / count
    target_y = sum(point[1] for point in target_points) / count
    denominator = 0.0
    real = 0.0
    imaginary = 0.0
    for (sx, sy), (tx, ty) in zip(source_points, target_points):
        x = sx - source_x
        y = sy - source_y
        east = tx - target_x
        north = ty - target_y
        denominator += x * x + y * y
        real += x * east + y * north
        imaginary += x * north - y * east
    if denominator <= 1e-12:
        return None
    if fixed_scale is None:
        a = real / denominator
        d = imaginary / denominator
    else:
        theta = math.atan2(imaginary, real)
        a = fixed_scale * math.cos(theta)
        d = fixed_scale * math.sin(theta)
    b = -d
    e = a
    xoff = target_x - (a * source_x + b * source_y)
    yoff = target_y - (d * source_x + e * source_y)
    squared = 0.0
    for (sx, sy), (tx, ty) in zip(source_points, target_points):
        dx = a * sx + b * sy + xoff - tx
        dy = d * sx + e * sy + yoff - ty
        squared += dx * dx + dy * dy
    return (a, b, d, e, xoff, yoff), math.sqrt(squared / count)


def fit_outlines(
    source: OutlineCandidate,
    target: OutlineCandidate,
    fixed_scale: float | None = None,
) -> tuple[tuple[float, float, float, float, float, float], float] | None:
    best: tuple[tuple[float, float, float, float, float, float], float] | None = None
    count = len(source.samples)
    for reverse in (False, True):
        sequence = tuple(reversed(target.samples)) if reverse else target.samples
        for start in range(count):
            paired = sequence[start:] + sequence[:start]
            fitted = fit_similarity(source.samples, paired, fixed_scale)
            if fitted is not None and (best is None or fitted[1] < best[1]):
                best = fitted
    return best


def overlap(left: Any, right: Any) -> float:
    try:
        union_area = float(left.union(right).area)
        if union_area <= 0:
            return 0.0
        return float(left.intersection(right).area) / union_area
    except (TypeError, ValueError):
        return 0.0


def outline_match(
    source: OutlineCandidate,
    target: OutlineCandidate,
    sheet: tuple[float, float],
    *,
    fixed_scale: float | None = None,
    center: tuple[float, float] | None = None,
    area_ratio: float | None = None,
    compactness_delta: float | None = None,
    elongation_delta: float | None = None,
    min_scale: float | None = None,
    max_scale: float | None = None,
    max_abs_rotation_deg: float | None = None,
    min_iou: float = _MATCH_MIN_IOU,
    max_normalized_rmse: float = _MATCH_MAX_NORMALIZED_RMSE,
) -> OutlineMatch | None:
    if area_ratio is not None:
        ratio = source.area / target.area
        if not 1.0 / area_ratio <= ratio <= area_ratio:
            return None
    if (
        compactness_delta is not None
        and abs(source.compactness - target.compactness) > compactness_delta
    ):
        return None
    if (
        elongation_delta is not None
        and abs(source.elongation - target.elongation) > elongation_delta
    ):
        return None
    fitted = fit_outlines(source, target, fixed_scale)
    if fitted is None:
        return None
    matrix, rmse = fitted
    a, b, d, e, xoff, yoff = matrix
    scale = math.hypot(a, d)
    rotation_deg = math.degrees(math.atan2(d, a))
    if min_scale is not None and scale < min_scale:
        return None
    if max_scale is not None and scale > max_scale:
        return None
    if max_abs_rotation_deg is not None and abs(rotation_deg) > max_abs_rotation_deg:
        return None
    moved = make_valid(affine_transform(source.geom, matrix))
    if moved.geom_type == "MultiPolygon":
        moved = max(moved.geoms, key=lambda part: part.area)
    if moved.geom_type != "Polygon":
        return None
    overlap_iou = overlap(moved, target.geom)
    normalized_rmse = rmse / max(math.sqrt(target.area), 1.0)
    if overlap_iou < min_iou or normalized_rmse > max_normalized_rmse:
        return None
    pivot = center if center is not None else (sheet[0] / 2.0, sheet[1] / 2.0)
    mapped_x = a * pivot[0] + b * pivot[1] + xoff
    mapped_y = d * pivot[0] + e * pivot[1] + yoff
    return OutlineMatch(
        source_index=source.index,
        target_index=target.index,
        matrix=matrix,
        scale=scale,
        rotation_deg=rotation_deg,
        center_shift=(mapped_x - pivot[0], mapped_y - pivot[1]),
        overlap_iou=overlap_iou,
        normalized_rmse=normalized_rmse,
        weight=math.sqrt(min(source.area, target.area)),
    )


def rotation_difference(left: float, right: float) -> float:
    return abs((left - right + 180.0) % 360.0 - 180.0)


def same_transform(
    left: OutlineMatch,
    right: OutlineMatch,
    translation_tolerance: float,
) -> bool:
    return (
        math.dist(left.center_shift, right.center_shift) <= translation_tolerance
        and rotation_difference(left.rotation_deg, right.rotation_deg)
        <= _CLUSTER_ROTATION_TOLERANCE_DEG
        and abs(left.scale - right.scale) / max(left.scale, right.scale)
        <= _CLUSTER_SCALE_TOLERANCE
    )


def independent_matches(matches: list[OutlineMatch]) -> list[OutlineMatch]:
    """One vote per source and target outline; fill/stroke copies count once."""
    chosen: list[OutlineMatch] = []
    source_indexes: set[int] = set()
    target_indexes: set[int] = set()
    for match in sorted(
        matches,
        key=lambda item: (-item.overlap_iou, item.normalized_rmse, -item.weight),
    ):
        if (
            match.source_index in source_indexes
            or match.target_index in target_indexes
        ):
            continue
        chosen.append(match)
        source_indexes.add(match.source_index)
        target_indexes.add(match.target_index)
    return chosen


def match_clusters(
    matches: list[OutlineMatch], sheet: tuple[float, float]
) -> list[list[OutlineMatch]]:
    translation_tolerance = max(1.0, math.hypot(*sheet) * 0.001)
    unique: dict[tuple[tuple[int, int], ...], list[OutlineMatch]] = {}
    for seed in matches:
        independent = independent_matches(
            [
                match
                for match in matches
                if same_transform(seed, match, translation_tolerance)
            ]
        )
        key = tuple(
            sorted((match.source_index, match.target_index) for match in independent)
        )
        if key:
            unique[key] = independent
    clusters = list(unique.values())
    clusters.sort(
        key=lambda cluster: (
            -len(cluster),
            -sum(match.weight for match in cluster),
            -sum(match.overlap_iou for match in cluster) / len(cluster),
        )
    )
    return clusters


def transform_distance(
    left: OutlineMatch, right: OutlineMatch, sheet: tuple[float, float]
) -> float:
    translation_tolerance = max(1.0, math.hypot(*sheet) * 0.001)
    return (
        math.dist(left.center_shift, right.center_shift) / translation_tolerance
        + rotation_difference(left.rotation_deg, right.rotation_deg)
        / _CLUSTER_ROTATION_TOLERANCE_DEG
        + abs(left.scale - right.scale)
        / max(left.scale, right.scale)
        / _CLUSTER_SCALE_TOLERANCE
    )
