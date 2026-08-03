"""Similarity georeferencing for Illustrator artwork.

Artwork coordinates are PDF points, y-up from a bottom-left origin, so no axis
flip is needed anywhere in this module.

A placement is a 4-DOF similarity transform stored relative to an anchor the
user can see: rotation pivots about that anchor and changing the scale does not
translate the drawing. ``map_anchor`` is WGS84 lon/lat so a saved placement
survives a change of output CRS; ``working_crs`` is the metric frame that
geometry is built in and is fixed for the life of a placement.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache

from pyproj import Transformer

MM_PER_INCH = 25.4
POINTS_PER_INCH = 72.0


class GeoreferenceError(ValueError):
    """Raised when a placement cannot be computed from the given inputs."""


@lru_cache(maxsize=64)
def _transformer(source: str, target: str) -> Transformer:
    # always_xy is mandatory: JPR CRSs declare X=north, Y=east, so the default
    # authority-compliant order would silently swap easting and northing.
    return Transformer.from_crs(source, target, always_xy=True)


def project_point(lon: float, lat: float, crs: str) -> tuple[float, float]:
    """WGS84 lon/lat to ``(easting, northing)`` in ``crs``."""
    east, north = _transformer("EPSG:4326", crs).transform(lon, lat)
    return float(east), float(north)


def unproject_point(east: float, north: float, crs: str) -> tuple[float, float]:
    """``(easting, northing)`` in ``crs`` back to WGS84 ``(lon, lat)``."""
    lon, lat = _transformer(crs, "EPSG:4326").transform(east, north)
    return float(lon), float(lat)


def grid_convergence(lon: float, lat: float, crs: str) -> float:
    """Degrees CCW from ``crs`` grid north to true north at this point.

    Measured rather than approximated by ``(lon - lon0) * sin(lat)``, so it is
    correct for any projected CRS, not only a transverse Mercator zone.
    """
    east0, north0 = project_point(lon, lat, crs)
    east1, north1 = project_point(lon, lat + 0.0005, crs)
    return math.degrees(math.atan2(east1 - east0, north1 - north0))


def metres_per_point_for_scale(denominator: float) -> float:
    """Ground metres per PDF point for a ``1:denominator`` drawing."""
    if denominator <= 0:
        raise GeoreferenceError("Drawing scale denominator must be positive.")
    return (MM_PER_INCH / POINTS_PER_INCH) * denominator / 1000.0


@dataclass(slots=True)
class SimilarityTransform:
    """Translate, rotate and uniformly scale artwork points onto the ground."""

    artwork_anchor: tuple[float, float]
    map_anchor: tuple[float, float]
    rotation_deg: float
    metres_per_point: float
    working_crs: str

    def to_affine_matrix(self) -> list[float]:
        """Coefficients for ``shapely.affinity.affine_transform``.

        ``rotation_deg`` is measured from true north, but the matrix operates in
        ``working_crs`` grid space, so the meridian convergence is subtracted
        here. Skipping it is a silent error: 8 cm across a 59 m artwork, ~3 m
        across a 2.4 km site.
        """
        if self.metres_per_point <= 0:
            raise GeoreferenceError("metres_per_point must be positive.")
        lon, lat = self.map_anchor
        theta = math.radians(
            self.rotation_deg - grid_convergence(lon, lat, self.working_crs)
        )
        scale = self.metres_per_point
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        a, b = scale * cos_t, -scale * sin_t
        d, e = scale * sin_t, scale * cos_t
        x0, y0 = self.artwork_anchor
        east, north = project_point(lon, lat, self.working_crs)
        return [a, b, d, e, east - (a * x0 + b * y0), north - (d * x0 + e * y0)]
