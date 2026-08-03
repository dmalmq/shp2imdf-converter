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


def _validate_pairs(
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
) -> None:
    if len(artwork_points) != len(map_points):
        raise GeoreferenceError("Each control point needs both an artwork and a map position.")
    if len(artwork_points) < 2:
        raise GeoreferenceError("At least two control points are required.")


def fit_helmert(
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
    working_crs: str,
    fixed_metres_per_point: float | None = None,
) -> SimilarityTransform:
    """Least-squares 4-parameter Helmert fit, or 3-parameter when scale is locked.

    Closed form in the complex plane: with artwork points ``p`` and target
    points ``q`` taken about their centroids, ``s*exp(i*theta)`` equals
    ``sum(q * conj(p)) / sum(|p|^2)``. Locking the scale reduces this to the
    argument of the numerator alone, which is better conditioned.
    """
    _validate_pairs(artwork_points, map_points)

    projected = [project_point(lon, lat, working_crs) for lon, lat in map_points]
    p_bar = complex(
        sum(x for x, _ in artwork_points) / len(artwork_points),
        sum(y for _, y in artwork_points) / len(artwork_points),
    )
    q_bar = complex(
        sum(e for e, _ in projected) / len(projected),
        sum(n for _, n in projected) / len(projected),
    )
    p = [complex(x, y) - p_bar for x, y in artwork_points]
    q = [complex(e, n) - q_bar for e, n in projected]

    denominator = sum(abs(value) ** 2 for value in p)
    if denominator <= 0:
        raise GeoreferenceError("Control points in the artwork must not all be the same point.")

    numerator = sum(qi * pi.conjugate() for qi, pi in zip(q, p))
    if numerator == 0:
        raise GeoreferenceError("Control points on the map must not all be the same point.")

    grid_rotation = math.degrees(math.atan2(numerator.imag, numerator.real))
    scale = (
        fixed_metres_per_point
        if fixed_metres_per_point is not None
        else abs(numerator) / denominator
    )
    if scale <= 0:
        raise GeoreferenceError("Fitted scale must be positive.")

    anchor_lon, anchor_lat = unproject_point(q_bar.real, q_bar.imag, working_crs)
    # The fit ran in grid space; SimilarityTransform stores true-north rotation.
    rotation = grid_rotation + grid_convergence(anchor_lon, anchor_lat, working_crs)
    return SimilarityTransform(
        artwork_anchor=(p_bar.real, p_bar.imag),
        map_anchor=(anchor_lon, anchor_lat),
        rotation_deg=(rotation + 180.0) % 360.0 - 180.0,
        metres_per_point=scale,
        working_crs=working_crs,
    )


def residuals(
    transform: SimilarityTransform,
    artwork_points: list[tuple[float, float]],
    map_points: list[tuple[float, float]],
) -> tuple[list[float], float]:
    """Per-point misfit in metres, and their RMSE."""
    _validate_pairs(artwork_points, map_points)
    a, b, d, e, xoff, yoff = transform.to_affine_matrix()
    distances: list[float] = []
    for (x, y), (lon, lat) in zip(artwork_points, map_points):
        east, north = project_point(lon, lat, transform.working_crs)
        distances.append(math.dist((a * x + b * y + xoff, d * x + e * y + yoff), (east, north)))
    rmse = math.sqrt(sum(value**2 for value in distances) / len(distances))
    return distances, rmse


# Japan Plane Rectangular CS I-XIX under JGD2011, EPSG:6669-6687 in order.
JPR_ZONES: tuple[str, ...] = (
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
    "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX",
)

# (lat_0, lon_0) per zone, fixed by 測量法施行令 and pinned by test.
ZONE_ORIGINS: dict[str, tuple[float, float]] = {
    "I": (33.0, 129.5), "II": (33.0, 131.0), "III": (36.0, 132.0 + 10 / 60),
    "IV": (33.0, 133.5), "V": (36.0, 134.0 + 20 / 60), "VI": (36.0, 136.0),
    "VII": (36.0, 137.0 + 10 / 60), "VIII": (36.0, 138.5),
    "IX": (36.0, 139.0 + 50 / 60), "X": (40.0, 140.0 + 50 / 60),
    "XI": (44.0, 140.25), "XII": (44.0, 142.25), "XIII": (44.0, 144.25),
    "XIV": (26.0, 142.0), "XV": (26.0, 127.5), "XVI": (26.0, 124.0),
    "XVII": (26.0, 131.0), "XVIII": (20.0, 136.0), "XIX": (26.0, 154.0),
}

# ISO 3166-2:JP code to candidate zones. Forty-three prefectures have exactly
# one. Hokkaido, Tokyo, Okinawa and Kagoshima span several and are narrowed
# geometrically among their own candidates.
PREFECTURE_ZONES: dict[str, tuple[str, ...]] = {
    "JP-01": ("XI", "XII", "XIII"), "JP-02": ("X",), "JP-03": ("X",),
    "JP-04": ("X",), "JP-05": ("X",), "JP-06": ("X",), "JP-07": ("IX",),
    "JP-08": ("IX",), "JP-09": ("IX",), "JP-10": ("IX",), "JP-11": ("IX",),
    "JP-12": ("IX",), "JP-13": ("IX", "XIV", "XVIII", "XIX"), "JP-14": ("IX",),
    "JP-15": ("VIII",), "JP-16": ("VII",), "JP-17": ("VII",), "JP-18": ("VI",),
    "JP-19": ("VIII",), "JP-20": ("VIII",), "JP-21": ("VII",), "JP-22": ("VIII",),
    "JP-23": ("VII",), "JP-24": ("VI",), "JP-25": ("VI",), "JP-26": ("VI",),
    "JP-27": ("VI",), "JP-28": ("V",), "JP-29": ("VI",), "JP-30": ("VI",),
    "JP-31": ("V",), "JP-32": ("III",), "JP-33": ("V",), "JP-34": ("III",),
    "JP-35": ("III",), "JP-36": ("IV",), "JP-37": ("IV",), "JP-38": ("IV",),
    "JP-39": ("IV",), "JP-40": ("II",), "JP-41": ("II",), "JP-42": ("I",),
    "JP-43": ("II",), "JP-44": ("II",), "JP-45": ("II",), "JP-46": ("II", "I"),
    "JP-47": ("XV", "XVI", "XVII"),
}


def zone_epsg(roman: str) -> int:
    """EPSG code for a JPR zone given its Roman numeral."""
    try:
        return 6669 + JPR_ZONES.index(roman)
    except ValueError as exc:
        raise GeoreferenceError(f"Unknown Japan Plane Rectangular zone: {roman}") from exc


def _nearest_zone(lon: float, lat: float, candidates: tuple[str, ...]) -> str:
    def separation(roman: str) -> float:
        lat0, lon0 = ZONE_ORIGINS[roman]
        return math.hypot((lon - lon0) * math.cos(math.radians(lat)), lat - lat0)

    return min(candidates, key=separation)


def resolve_working_crs(lon: float, lat: float, prefecture_code: str | None = None) -> str:
    """Pick the JPR zone for a location.

    Zone membership is defined by prefecture, so an ISO 3166-2 code is
    authoritative and is used whenever one is available. Without one — the
    geocoder is optional — the nearest zone origin is used instead. That is
    right for 20 of 21 reference cities but places Hakodate in zone X rather
    than XI, because zone X's origin is closer across the Tsugaru Strait.
    """
    candidates = PREFECTURE_ZONES.get(prefecture_code or "", JPR_ZONES)
    if len(candidates) == 1:
        return f"EPSG:{zone_epsg(candidates[0])}"
    return f"EPSG:{zone_epsg(_nearest_zone(lon, lat, candidates))}"


def zone_label(crs: str) -> str:
    """``"EPSG:6677 — JPR CS IX"`` for JPR zones, the bare code otherwise."""
    try:
        code = int(crs.split(":")[1])
    except (IndexError, ValueError):
        return crs
    if 6669 <= code <= 6687:
        return f"{crs} — JPR CS {JPR_ZONES[code - 6669]}"
    return crs
