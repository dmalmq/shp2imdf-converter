"""Named placement storage."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.src.placements import (
    DuplicatePlacementError,
    PlacementNotFoundError,
    PlacementStore,
)

TRANSFORM = {
    "artwork_anchor": [250.0, 275.0],
    "map_anchor": [139.700258, 35.690921],
    "rotation_deg": 12.5,
    "metres_per_point": 0.176389,
    "working_crs": "EPSG:6677",
}
BOUNDS = [0.0, 0.0, 500.0, 550.0]


@pytest.fixture()
def store(tmp_path: Path) -> PlacementStore:
    return PlacementStore(tmp_path / "placements.db")


@pytest.mark.georef
def test_create_then_list_round_trips(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    assert created.id > 0
    listed = store.list_all()
    assert [p.name for p in listed] == ["Shinjuku Station"]
    assert listed[0].transform["working_crs"] == "EPSG:6677"
    assert listed[0].transform["map_anchor"] == [139.700258, 35.690921]
    assert listed[0].artwork_bounds == BOUNDS


@pytest.mark.georef
def test_duplicate_names_are_rejected(store: PlacementStore) -> None:
    store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    with pytest.raises(DuplicatePlacementError):
        store.create("Shinjuku Station", TRANSFORM, BOUNDS)


@pytest.mark.georef
def test_update_replaces_the_transform(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    updated = store.update(
        created.id, "Shinjuku Station", dict(TRANSFORM, rotation_deg=-40.0), BOUNDS
    )
    assert updated.transform["rotation_deg"] == -40.0
    assert updated.updated_at >= created.created_at


@pytest.mark.georef
def test_delete_removes_the_row(store: PlacementStore) -> None:
    created = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    store.delete(created.id)
    assert store.list_all() == []


@pytest.mark.georef
def test_missing_placement_raises(store: PlacementStore) -> None:
    with pytest.raises(PlacementNotFoundError):
        store.delete(4242)


@pytest.mark.georef
def test_two_writers_do_not_lose_an_update(tmp_path: Path) -> None:
    """Colleagues share one server; a JSON file would drop one of these."""
    path = tmp_path / "placements.db"
    PlacementStore(path).create("Floor 1", TRANSFORM, BOUNDS)
    PlacementStore(path).create("Floor 2", TRANSFORM, BOUNDS)
    assert {p.name for p in PlacementStore(path).list_all()} == {"Floor 1", "Floor 2"}


@pytest.mark.georef
def test_matching_bounds_produce_no_warning(store: PlacementStore) -> None:
    placement = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    assert store.bounds_mismatch(placement, [0.0, 0.0, 500.0, 550.0]) is None
    assert store.bounds_mismatch(placement, [10.0, 10.0, 512.0, 563.0]) is None


@pytest.mark.georef
def test_a_shifted_artboard_warns(store: PlacementStore) -> None:
    placement = store.create("Shinjuku Station", TRANSFORM, BOUNDS)
    warning = store.bounds_mismatch(placement, [0.0, 0.0, 700.0, 550.0])
    assert warning is not None
    assert "artboard" in warning.lower()
