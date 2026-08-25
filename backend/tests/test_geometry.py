"""Unions have to survive the geometry real station drawings actually contain."""

from __future__ import annotations

import pytest
from shapely.errors import GEOSException
from shapely.geometry import Polygon

from backend.src import geometry
from backend.src.geometry import safe_union


def _square(x: float, y: float, size: float = 0.001) -> Polygon:
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)])


@pytest.mark.phase5
def test_nothing_to_union_is_not_an_error() -> None:
    assert safe_union([]) is None
    assert safe_union([None, Polygon()]) is None


@pytest.mark.phase5
def test_a_plain_union_is_left_alone() -> None:
    merged = safe_union([_square(139.70, 35.68), _square(139.701, 35.68)])
    assert merged is not None
    assert merged.area == pytest.approx(2e-6, rel=1e-6)


@pytest.mark.phase5
def test_a_self_intersecting_ring_is_repaired_rather_than_raised(monkeypatch) -> None:
    """GEOS refuses a side location conflict; the retry path has to catch it.

    The exception is forced rather than conjured from coordinates: which shapes
    trip it depends on the GEOS build, and the point of the test is that the
    recovery runs, not that a particular polygon offends this version.
    """
    bowtie = Polygon([(0, 0), (1, 1), (1, 0), (0, 1), (0, 0)])
    assert not bowtie.is_valid

    calls: list[int] = []
    real_unary_union = geometry.unary_union

    def exploding_unary_union(geoms):
        calls.append(1)
        raise GEOSException(
            "TopologyException: side location conflict at 139.73892534653464 35.634146823762464"
        )

    monkeypatch.setattr(geometry, "unary_union", exploding_unary_union)
    merged = safe_union([bowtie, _square(0.5, 0.5, 1.0)])

    assert calls, "the plain union is still attempted first"
    assert merged is not None and not merged.is_empty
    assert real_unary_union is not None


@pytest.mark.phase5
def test_an_envelope_union_is_the_last_resort(monkeypatch) -> None:
    monkeypatch.setattr(
        geometry,
        "unary_union",
        lambda geoms: (_ for _ in ()).throw(GEOSException("side location conflict")),
    )
    snapped: list[float] = []

    def failing_union_all(geoms, grid_size=None):
        if grid_size is not None:
            snapped.append(grid_size)
            raise GEOSException("side location conflict")
        return geoms[0]

    monkeypatch.setattr(geometry, "union_all", failing_union_all)
    merged = safe_union([_square(0, 0), _square(0.0005, 0)])

    assert snapped == list(geometry.GRID_SIZES), "every tolerance is tried before giving up"
    assert merged is not None


@pytest.mark.phase5
def test_growing_a_level_swallows_what_falls_outside_it() -> None:
    from backend.src.geometry import grow_to_cover

    level = _square(139.70, 35.68, 0.001)
    outside = _square(139.7015, 35.68, 0.0005)
    grown = grow_to_cover(level, [outside])

    assert grown is not None
    assert grown.contains(outside)
    assert grown.contains(level)
    assert grown.geom_type in {"Polygon", "MultiPolygon"}


@pytest.mark.phase5
def test_a_line_is_given_width_before_it_is_swallowed() -> None:
    """Unioning a zero-width line into a polygon yields a GeometryCollection,
    which is not a level."""
    from shapely.geometry import LineString

    from backend.src.geometry import grow_to_cover

    level = _square(139.70, 35.68, 0.001)
    walkway = LineString([(139.7015, 35.6805), (139.7025, 35.6805)])
    grown = grow_to_cover(level, [walkway])

    assert grown is not None
    assert grown.geom_type in {"Polygon", "MultiPolygon"}
    assert grown.intersects(walkway)


@pytest.mark.phase5
def test_nothing_to_grow_is_not_an_error() -> None:
    from backend.src.geometry import grow_to_cover

    assert grow_to_cover(_square(0, 0), []) is None
    assert grow_to_cover(None, []) is None


@pytest.mark.phase5
def test_a_ring_shaped_room_is_inside_its_floor_even_though_its_centroid_is_not() -> None:
    """The check used to test the centroid, which raised 20 false alarms on one
    real station: a U- or ring-shaped room has its centroid in the gap."""
    from shapely.geometry import Polygon as _Polygon

    from backend.src.geometry import covers_within_tolerance

    floor = _square(0, 0, 10)
    ring = _Polygon(
        [(1, 1), (9, 1), (9, 9), (1, 9)],
        [[(2, 2), (8, 2), (8, 8), (2, 8)]],
    )
    assert not ring.contains(ring.centroid), "the centroid falls in the hole"
    assert covers_within_tolerance(floor, ring)


@pytest.mark.phase5
def test_a_sliver_on_the_boundary_is_inside_but_a_real_overhang_is_not() -> None:
    from backend.src.geometry import covers_within_tolerance

    floor = _square(0, 0, 10)
    # Over the edge by a hair, the way a redrawn floor leaves its neighbours.
    hair = _square(1, 1, 8.999999999999)
    assert covers_within_tolerance(floor, hair)
    # Half out is not a sliver.
    half_out = _square(5, 0, 10)
    assert not covers_within_tolerance(floor, half_out)
    # And wholly out certainly is not.
    assert not covers_within_tolerance(floor, _square(20, 20, 1))
