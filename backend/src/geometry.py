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
