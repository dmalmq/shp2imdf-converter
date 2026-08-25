"""Geometry operations that have to survive real source data.

Station drawings arrive from CAD with near-coincident edges, hairline slivers
and rings that self-intersect. GEOS refuses to union those with a
TopologyException, which crashes whatever was unioning them. Anything that
unions source geometry goes through here so the repair cannot be forgotten at
one call site and present at another.
"""

from __future__ import annotations

from typing import Any

from shapely import union_all
from shapely.errors import GEOSException
from shapely.ops import unary_union
from shapely.validation import make_valid


# Snapping tolerances tried in turn, in degrees. 1e-9 is about 0.1 mm at this
# latitude, so the first that works has not moved anything that matters.
GRID_SIZES = (1e-9, 1e-8, 1e-7, 1e-6)


def safe_union(geoms: list[Any]) -> Any | None:
    """Union geometries, tolerating invalid or near-coincident source data.

    GEOS raises a TopologyException ("side location conflict") when unioning
    polygons whose edges nearly coincide, which is common in ODC column data.
    Retry with each part made valid and the operation snapped to a fine grid,
    then fall back to an envelope union that cannot side-location conflict.

    Returns None only when there was nothing to union or every repair failed;
    callers treat that the same as an empty result.
    """
    cleaned = [geom for geom in geoms if geom is not None and not geom.is_empty]
    if not cleaned:
        return None
    try:
        return unary_union(cleaned)
    except GEOSException:
        pass
    valid: list[Any] = []
    for geom in cleaned:
        try:
            fixed = make_valid(geom)
        except Exception:
            continue
        if not fixed.is_empty:
            valid.append(fixed)
    if not valid:
        return None
    for grid_size in GRID_SIZES:
        try:
            return union_all(valid, grid_size=grid_size)
        except GEOSException:
            continue
    try:
        return union_all([geom.envelope for geom in valid])
    except GEOSException:
        return None


# A level is a floor plate, not a hairline outline: growing it to swallow a
# walkway that runs off the building needs the walkway's own width, and a line
# or a point has none. 1e-6 degrees is about 10 cm here.
COVER_BUFFER_DEGREES = 1e-6


def grow_to_cover(base: Any, additions: list[Any]) -> Any | None:
    """Expand a polygon so it contains everything in ``additions``.

    Apple rejects a unit whose geometry falls outside the level it names —
    reported as "Invalid level reference", which reads like a broken id rather
    than a geometry that does not fit. Rather than move the unit, the floor it
    belongs to is grown to hold it.

    Non-polygonal additions are buffered first: unioning a zero-width line into
    a polygon adds nothing and yields a GeometryCollection, which is not a level.
    Returns None when there is nothing to grow.
    """
    wanted: list[Any] = []
    for geom in additions:
        if geom is None or geom.is_empty:
            continue
        wanted.append(geom if geom.geom_type in {"Polygon", "MultiPolygon"} else geom.buffer(COVER_BUFFER_DEGREES))
    if not wanted:
        return None
    if base is not None and not base.is_empty:
        wanted.append(base)
    merged = safe_union(wanted)
    if merged is None or merged.is_empty:
        return None
    # A level has to stay a surface; a union that degenerates is worse than
    # leaving the level alone.
    return merged if merged.geom_type in {"Polygon", "MultiPolygon"} else None


# A unit that genuinely hangs off its floor is wholly or largely outside it.
# What sits on the boundary differs by a sliver of no area at all, which strict
# topology still calls a miss — and every floor is tiled with units sharing its
# outline, so the strict answer fails dozens of them the moment the floor is
# redrawn.
COVER_AREA_TOLERANCE = 1e-9


def covers_within_tolerance(container: Any, target: Any) -> bool:
    """Whether ``target`` sits inside ``container``, ignoring zero-area slivers."""
    if container is None or target is None or container.is_empty or target.is_empty:
        return False
    try:
        if container.covers(target):
            return True
        outside = target.difference(container)
        if outside.is_empty:
            return True
        return outside.area <= max(target.area, 0.0) * COVER_AREA_TOLERANCE
    except GEOSException:
        return False
