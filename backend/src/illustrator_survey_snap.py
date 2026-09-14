"""Consensus placement of a whole drawing onto surveyed Station_pg polygons.

Every large closed or closable artwork outline on every assigned floor is
fitted against every survey polygon at the locked drawing scale. Fits that
agree on one pose form a cluster, and the drawing snaps to the largest
cluster only when it clearly outvotes the runner-up. A single pair, however
good, never moves the drawing.
"""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import dataclass
from typing import Any
from typing import Mapping

import geopandas as gpd
from shapely import make_valid
from shapely import to_geojson
from shapely.affinity import affine_transform
from shapely.ops import unary_union

from backend.src.illustrator_export import _floor_mask
from backend.src.illustrator_export import _read_layers
from backend.src.illustrator_georeference import SimilarityTransform
from backend.src.illustrator_georeference import grid_convergence
from backend.src.illustrator_georeference import unproject_point
from backend.src.illustrator_outline_match import OutlineCandidate
from backend.src.illustrator_outline_match import OutlineMatch
from backend.src.illustrator_outline_match import build_candidates
from backend.src.illustrator_outline_match import independent_matches
from backend.src.illustrator_outline_match import outline_match
from backend.src.illustrator_outline_match import rotation_difference
from backend.src.illustrator_shape_match import NO_ASSIGNMENT_ERROR
from backend.src.illustrator_shape_match import _apply_matrix
from backend.src.illustrator_shape_match import _as_outline_polygon
from backend.src.illustrator_shape_match import _iter_reference_parts
from backend.src.illustrator_shape_match import _percentile
from backend.src.illustrator_shape_match import _residual_vectors
from backend.src.illustrator_shape_match import _rmse
from backend.src.illustrator_shape_match import _symmetric_distances
from backend.src.illustrator_shape_match import _to_wgs84
from backend.src.illustrator_shape_match import assigned_floor
from backend.src.illustrator_store import CachedConversion

Matrix = tuple[float, float, float, float, float, float]


@dataclass(frozen=True)
class SurveyConsensusSpec:
    min_support: int = 3
    runner_support_ratio: float = 0.8
    rotation_tolerance_deg: float = 1.0
    centre_tolerance_m: float = 10.0
    min_iou: float = 0.6
    max_normalized_rmse: float = 0.3
    min_artwork_area_m2: float = 800.0
    min_reference_area_m2: float = 300.0
    artwork_limit: int = 60
    reference_limit: int = 400
    default_layer: str = "Station_pg"


SURVEY_CONSENSUS = SurveyConsensusSpec()


@dataclass(slots=True, frozen=True)
class _Vote:
    """One fitted artwork/survey pair and where it puts the drawing's centre."""

    match: OutlineMatch
    centre: tuple[float, float]


def match_survey_consensus(
    cached: CachedConversion,
    *,
    reference: Mapping[str, Any],
    current: SimilarityTransform,
    spec: SurveyConsensusSpec = SURVEY_CONSENSUS,
) -> dict[str, Any] | None:
    """The pose most artwork outlines agree on, as one suggestion, or ``None``.

    ``current`` supplies the locked ``metres_per_point``, the working CRS and
    the artwork anchor the result is expressed at. Its position is not used.
    Raises ``ValueError`` when no floor assignment is stored.
    """
    sources = _artwork_candidates(cached, current.metres_per_point, spec)
    targets, origins = _reference_candidates(reference, current.working_crs, spec)
    if not sources or not targets:
        return None
    pivot = _pivot(sources)
    votes = _votes(sources, targets, pivot, current.metres_per_point, spec)
    winner = _largest_cluster(votes, spec)
    chosen = {id(vote) for vote in winner}
    runner_up = _largest_cluster([vote for vote in votes if id(vote) not in chosen], spec)
    if len(winner) < spec.min_support:
        return None
    if len(runner_up) >= spec.runner_support_ratio * len(winner):
        return None
    return _suggestion(winner, sources, targets, origins, current, spec)


def _artwork_candidates(
    cached: CachedConversion, metres_per_point: float, spec: SurveyConsensusSpec
) -> list[OutlineCandidate]:
    if not cached.floors:
        raise ValueError(NO_ASSIGNMENT_ERROR)
    floors = [assigned_floor(stored) for stored in cached.floors]
    outlines = []
    for _layer, frame in _read_layers(cached):
        if frame.empty:
            continue
        member = _floor_mask(frame, floors[0])
        for floor in floors[1:]:
            member |= _floor_mask(frame, floor)
        for geom in frame.geometry[member]:
            if geom is None or geom.is_empty:
                continue
            try:
                outlines.append(_as_outline_polygon(geom))
            except ValueError:
                continue
    return build_candidates(
        outlines,
        minimum_area=spec.min_artwork_area_m2 / (metres_per_point * metres_per_point),
        limit=spec.artwork_limit,
    )


def _reference_candidates(
    reference: Mapping[str, Any], working_crs: str, spec: SurveyConsensusSpec
) -> tuple[list[OutlineCandidate], dict[bytes, tuple[int, int]]]:
    parts = list(_iter_reference_parts(reference))
    if not parts:
        return [], {}
    projected = gpd.GeoSeries([geom for _, _, geom in parts], crs="EPSG:4326").to_crs(working_crs)
    polygons = []
    origins: dict[bytes, tuple[int, int]] = {}
    for (feature_index, part_index, _), geom in zip(parts, projected):
        geom = make_valid(geom)
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda part: part.area)
        if geom.geom_type != "Polygon" or geom.area <= 0:
            continue
        polygons.append(geom)
        origins.setdefault(geom.normalize().wkb, (feature_index, part_index))
    candidates = build_candidates(
        polygons, minimum_area=spec.min_reference_area_m2, limit=spec.reference_limit
    )
    return candidates, origins


def _pivot(sources: list[OutlineCandidate]) -> tuple[float, float]:
    bounds = [candidate.geom.bounds for candidate in sources]
    minx = min(item[0] for item in bounds)
    miny = min(item[1] for item in bounds)
    maxx = max(item[2] for item in bounds)
    maxy = max(item[3] for item in bounds)
    return ((minx + maxx) / 2.0, (miny + maxy) / 2.0)


def _votes(
    sources: list[OutlineCandidate],
    targets: list[OutlineCandidate],
    pivot: tuple[float, float],
    metres_per_point: float,
    spec: SurveyConsensusSpec,
) -> list[_Vote]:
    minx = min(candidate.geom.bounds[0] for candidate in sources)
    miny = min(candidate.geom.bounds[1] for candidate in sources)
    sheet = (max(2.0 * (pivot[0] - minx), 1.0), max(2.0 * (pivot[1] - miny), 1.0))
    votes: list[_Vote] = []
    for source in sources:
        source_area = source.area * metres_per_point * metres_per_point
        for target in targets:
            # Overlap over union can never beat the smaller area over the
            # larger, so this skips only pairs the IoU gate would reject anyway.
            if min(source_area, target.area) < spec.min_iou * max(source_area, target.area):
                continue
            match = outline_match(
                source,
                target,
                sheet,
                fixed_scale=metres_per_point,
                min_iou=spec.min_iou,
                max_normalized_rmse=spec.max_normalized_rmse,
            )
            if match is not None:
                votes.append(_Vote(match=match, centre=_apply_matrix(list(match.matrix), pivot)))
    return votes


# Clustering compares the mapped sheet centre in working-CRS metres rather
# than reusing match_clusters: its translation tolerance is a fraction of the
# sheet diagonal in artwork points, and OutlineMatch.center_shift subtracts a
# point pivot from a metre position when the target is a projected survey.
def _agrees(left: _Vote, right: _Vote, spec: SurveyConsensusSpec) -> bool:
    return (
        rotation_difference(left.match.rotation_deg, right.match.rotation_deg)
        <= spec.rotation_tolerance_deg
        and math.dist(left.centre, right.centre) <= spec.centre_tolerance_m
    )


def _pose_distance(left: _Vote, right: _Vote, spec: SurveyConsensusSpec) -> float:
    return (
        rotation_difference(left.match.rotation_deg, right.match.rotation_deg)
        / spec.rotation_tolerance_deg
        + math.dist(left.centre, right.centre) / spec.centre_tolerance_m
    )


def _largest_cluster(votes: list[_Vote], spec: SurveyConsensusSpec) -> list[_Vote]:
    best: list[_Vote] = []
    best_key: tuple[int, float, float] | None = None
    for seed in votes:
        agreeing = [vote for vote in votes if _agrees(seed, vote, spec)]
        by_match = {id(vote.match): vote for vote in agreeing}
        cluster = [by_match[id(match)] for match in independent_matches([vote.match for vote in agreeing])]
        key = (
            len(cluster),
            sum(vote.match.weight for vote in cluster),
            sum(vote.match.overlap_iou for vote in cluster) / len(cluster),
        )
        if best_key is None or key > best_key:
            best, best_key = cluster, key
    return best


def _transform_from_matrix(matrix: Matrix, current: SimilarityTransform) -> SimilarityTransform:
    a, _b, d, _e, _xoff, _yoff = matrix
    east, north = _apply_matrix(list(matrix), current.artwork_anchor)
    lon, lat = unproject_point(east, north, current.working_crs)
    grid_rotation = math.degrees(math.atan2(d, a))
    rotation = grid_rotation + grid_convergence(lon, lat, current.working_crs)
    return SimilarityTransform(
        artwork_anchor=current.artwork_anchor,
        map_anchor=(lon, lat),
        rotation_deg=(rotation + 180.0) % 360.0 - 180.0,
        metres_per_point=current.metres_per_point,
        working_crs=current.working_crs,
    )


def _suggestion(
    winner: list[_Vote],
    sources: list[OutlineCandidate],
    targets: list[OutlineCandidate],
    origins: dict[bytes, tuple[int, int]],
    current: SimilarityTransform,
    spec: SurveyConsensusSpec,
) -> dict[str, Any]:
    medoid = min(winner, key=lambda vote: sum(_pose_distance(vote, other, spec) for other in winner))
    source = sources[medoid.match.source_index]
    target = targets[medoid.match.target_index]
    matrix = list(medoid.match.matrix)
    transform = _transform_from_matrix(medoid.match.matrix, current)
    moved = make_valid(affine_transform(source.geom, matrix))
    if moved.geom_type == "MultiPolygon":
        moved = max(moved.geoms, key=lambda part: part.area)
    moved_samples = [_apply_matrix(matrix, point) for point in source.samples]
    distances = _symmetric_distances(moved_samples, list(target.samples), moved, target.geom)
    rmse = _rmse(distances)
    overlap = statistics.median(vote.match.overlap_iou for vote in winner)
    voted = unary_union([targets[vote.match.target_index].geom for vote in winner])
    feature_index, part_index = origins.get(target.geom.normalize().wkb, (0, 0))
    return {
        "rank": 1,
        "score": overlap / (1.0 + rmse),
        "relative_gap": None,
        "reference_feature_index": feature_index,
        "reference_part_index": part_index,
        "transform": {
            "artwork_anchor": [transform.artwork_anchor[0], transform.artwork_anchor[1]],
            "map_anchor": [transform.map_anchor[0], transform.map_anchor[1]],
            "rotation_deg": transform.rotation_deg,
            "metres_per_point": transform.metres_per_point,
            "working_crs": transform.working_crs,
        },
        "boundary_rmse_m": rmse,
        "boundary_p95_m": _percentile(distances, 95.0),
        "max_residual_m": max(distances) if distances else 0.0,
        "overlap_iou": overlap,
        "reference_geometry": json.loads(to_geojson(_to_wgs84(voted, current.working_crs))),
        "residual_vectors": _residual_vectors(moved_samples, target.geom, current.working_crs),
    }
