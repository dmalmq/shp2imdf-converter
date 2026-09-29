"""The placement draft an artwork project resumes from."""

from __future__ import annotations

import copy
import json
import threading
from pathlib import Path

import pytest

from backend.src.artwork_draft import MAX_DRAFT_BYTES, PlacementDraft
from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import (
    ConversionExpiredError,
    ConversionStore,
    DraftConflictError,
)
from backend.tests.test_illustrator_api import _TRAVERSING_IDS, _assign_body, _preview
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf
from backend.tests.test_illustrator_store import INVALID_IDS, filesystem_calls  # noqa: F401

pytestmark = pytest.mark.georef

_FLOORS = [
    {"label": "1F", "box": [0.0, 0.0, 85.0, 200.0], "pages": None, "layer_names": None},
    {"label": "2F", "box": [85.0, 0.0, 200.0, 200.0], "pages": None, "layer_names": None},
]


def _floor(label: str, **overrides) -> dict:
    floor = {
        "label": label,
        "linked": True,
        "pinned": False,
        "artwork_anchor": [42.5, 100.0],
        "map_anchor": [139.7671, 35.6812],
        "artwork_bounds": [0.0, 0.0, 85.0, 200.0],
        "rotation_deg": None,
        "metres_per_point": None,
        "artwork_match": False,
        "control_points": [],
    }
    floor.update(overrides)
    return floor


def _draft() -> dict:
    return {
        "version": 1,
        "placement": {
            "frame": {"rotation_deg": 12.5, "metres_per_point": 0.3527777777777778, "working_crs": "EPSG:6677"},
            "floors": [
                _floor("1F"),
                _floor(
                    "2F",
                    linked=False,
                    artwork_anchor=[142.5, 100.0],
                    map_anchor=[139.76723456789012, 35.68134567890123],
                    artwork_bounds=[85.0, 0.0, 200.0, 200.0],
                    rotation_deg=-3.25,
                    metres_per_point=0.35,
                    control_points=[
                        {"id": "1", "artwork": [90.0, 10.0], "map": [139.7672, 35.6813]},
                        {"id": "2", "artwork": [190.0, 190.0], "map": [139.7675, 35.6816]},
                    ],
                ),
            ],
            "scale_locked": True,
            "output_crs": "EPSG:6677",
            "formats": {"geopackage": False, "shapefile": True, "qgis": False},
        },
        "view": {
            "active_floor_label": "2F",
            "mode": "individual",
            "tab": "fit",
            "station_pin": [139.7671, 35.6812],
            "location": {
                "kind": "chosen",
                "query": "東京駅",
                "place": {"name": "東京駅", "lng_lat": [139.7671, 35.6812], "working_crs": "EPSG:6677"},
                "candidates": [
                    {"name": "東京駅", "lng_lat": [139.7671, 35.6812], "working_crs": "EPSG:6677"}
                ],
            },
            "references": {
                "preloaded": True,
                "include_lines": False,
                "hidden": ["Station_pl"],
                "removed": [],
                "uploads": ["survey.zip"],
            },
        },
    }


@pytest.fixture()
def store(tmp_path: Path) -> ConversionStore:
    return ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=10)


def _assigned(store: ConversionStore):
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, _FLOORS)
    return cached


def _project_json(directory: Path) -> dict:
    return json.loads((directory / "project.json").read_text(encoding="utf-8"))


def _model(payload: dict) -> PlacementDraft:
    return PlacementDraft.model_validate(payload)


# --- store ------------------------------------------------------------------


def test_a_saved_draft_reads_back_identically(store: ConversionStore) -> None:
    cached = _assigned(store)
    revision = store.draft(cached).revision

    saved = store.save_draft(cached.conversion_id, _model(_draft()), revision)

    assert saved.changed
    stored = store.draft(store.get(cached.conversion_id))
    assert stored.revision == saved.revision == revision + 1
    assert stored.draft is not None
    assert stored.draft.model_dump(mode="json") == _draft()


def test_saving_the_same_draft_again_changes_nothing(store: ConversionStore) -> None:
    cached = _assigned(store)
    first = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    project_before = (cached.directory / "project.json").read_bytes()
    draft_before = (cached.directory / "placement.json").stat().st_mtime_ns

    again = store.save_draft(cached.conversion_id, _model(_draft()), first.revision)

    assert not again.changed
    assert again.revision == first.revision
    assert (cached.directory / "project.json").read_bytes() == project_before
    assert (cached.directory / "placement.json").stat().st_mtime_ns == draft_before


def test_an_equal_draft_with_integer_numbers_is_still_no_change(store: ConversionStore) -> None:
    cached = _assigned(store)
    first = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    spelled = _draft()
    spelled["placement"]["floors"][0]["artwork_bounds"] = [0, 0, 85, 200]

    assert not store.save_draft(cached.conversion_id, _model(spelled), first.revision).changed


def test_placement_work_moves_content_changed_at(store: ConversionStore) -> None:
    cached = _assigned(store)
    first = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    before = _project_json(cached.directory)

    moved = _draft()
    moved["placement"]["floors"][1]["map_anchor"] = [139.768, 35.682]
    saved = store.save_draft(cached.conversion_id, _model(moved), first.revision)

    after = _project_json(cached.directory)
    assert saved.changed
    assert after["content_changed_at"] > before["content_changed_at"]
    assert after["updated_at"] == after["content_changed_at"]


def test_view_changes_are_saved_without_counting_as_an_edit(store: ConversionStore) -> None:
    cached = _assigned(store)
    first = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    project_before = (cached.directory / "project.json").read_bytes()

    looked = _draft()
    looked["view"].update(active_floor_label="1F", mode="group", tab="export")
    looked["view"]["references"]["hidden"] = []
    saved = store.save_draft(cached.conversion_id, _model(looked), first.revision)

    assert saved.changed and saved.revision == first.revision + 1
    assert (cached.directory / "project.json").read_bytes() == project_before
    assert store.draft(cached).draft.view.tab == "export"


def test_placed_floors_count_pins_and_enough_control_points(store: ConversionStore) -> None:
    cached = _assigned(store)
    revision = store.draft(cached).revision
    saved = store.save_draft(cached.conversion_id, _model(_draft()), revision)
    # 2F has two pairs with the scale locked: enough for a fit.
    assert _project_json(cached.directory)["floors_placed"] == 1

    unlocked = _draft()
    unlocked["placement"]["scale_locked"] = False
    saved = store.save_draft(cached.conversion_id, _model(unlocked), saved.revision)
    assert _project_json(cached.directory)["floors_placed"] == 0

    pinned = copy.deepcopy(unlocked)
    for floor in pinned["placement"]["floors"]:
        floor["pinned"] = True
    store.save_draft(cached.conversion_id, _model(pinned), saved.revision)
    assert _project_json(cached.directory)["floors_placed"] == 2
    summary = store.summary(cached.conversion_id)
    assert (summary.stage, summary.blockers) == ("deliver", 0)


def test_a_stale_revision_is_a_conflict(store: ConversionStore) -> None:
    cached = _assigned(store)
    revision = store.draft(cached).revision
    store.save_draft(cached.conversion_id, _model(_draft()), revision)

    with pytest.raises(DraftConflictError):
        store.save_draft(cached.conversion_id, _model(_draft()), revision)


def test_assigning_again_drops_the_draft_and_moves_the_revision_on(store: ConversionStore) -> None:
    cached = _assigned(store)
    saved = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)

    store.assign(cached.conversion_id, _FLOORS)

    stored = store.draft(store.get(cached.conversion_id))
    assert stored.draft is None
    assert stored.revision == saved.revision + 1
    with pytest.raises(DraftConflictError):
        store.save_draft(cached.conversion_id, _model(_draft()), saved.revision)


def test_a_draft_needs_the_stored_floor_labels(store: ConversionStore) -> None:
    unassigned = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    with pytest.raises(DraftConflictError):
        store.save_draft(unassigned.conversion_id, _model(_draft()), 0)

    cached = _assigned(store)
    renamed = _draft()
    renamed["placement"]["floors"][1]["label"] = "3F"
    with pytest.raises(DraftConflictError):
        store.save_draft(cached.conversion_id, _model(renamed), store.draft(cached).revision)


def test_an_unreadable_draft_reads_as_none(store: ConversionStore) -> None:
    cached = _assigned(store)
    saved = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    path = cached.directory / "placement.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["draft"]["version"] = 99
    path.write_text(json.dumps(stored), encoding="utf-8")

    reread = store.draft(cached)
    assert reread.draft is None
    assert reread.revision == saved.revision
    assert path.is_file(), "reading alone must not move the file"

    resaved = store.save_draft(cached.conversion_id, _model(_draft()), saved.revision)
    kept = cached.directory / "placement.v99.json"
    assert json.loads(kept.read_text(encoding="utf-8")) == stored
    assert resaved.revision == saved.revision + 1
    assert store.draft(cached).draft.model_dump(mode="json") == _draft()


def test_a_second_unreadable_draft_is_kept_beside_the_first(store: ConversionStore) -> None:
    cached = _assigned(store)
    path = cached.directory / "placement.json"
    for revision in (store.draft(cached).revision, None):
        current = store.draft(cached).revision if revision is None else revision
        path.write_text(json.dumps({"revision": current, "draft": {"version": 2}}), encoding="utf-8")
        store.save_draft(cached.conversion_id, _model(_draft()), current)
    assert (cached.directory / "placement.v2.json").is_file()
    assert (cached.directory / "placement.v2.2.json").is_file()


def test_assigning_again_keeps_an_unreadable_draft(store: ConversionStore) -> None:
    cached = _assigned(store)
    (cached.directory / "placement.json").write_text(
        json.dumps({"revision": 7, "draft": {"version": "next"}}), encoding="utf-8"
    )
    store.assign(cached.conversion_id, _FLOORS)
    assert (cached.directory / "placement.unreadable.json").is_file()
    assert store.draft(cached).revision == 8


def test_a_baseline_first_save_is_not_an_edit(store: ConversionStore) -> None:
    cached = _assigned(store)
    _, snapshot = store.open_for_export(cached.conversion_id)
    store.mark_delivered(cached.conversion_id, 2, snapshot)
    before = (cached.directory / "project.json").read_bytes()

    saved = store.save_draft(
        cached.conversion_id, _model(_draft()), store.draft(cached).revision, baseline=True
    )

    assert saved.changed
    assert (cached.directory / "project.json").read_bytes() == before
    assert store.summary(cached.conversion_id).stage == "deliver"
    assert store.draft(cached).draft is not None


def test_baseline_only_matters_before_the_first_draft(store: ConversionStore) -> None:
    cached = _assigned(store)
    first = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    before = _project_json(cached.directory)
    moved = _draft()
    moved["placement"]["frame"]["rotation_deg"] = 40.0

    store.save_draft(cached.conversion_id, _model(moved), first.revision, baseline=True)

    assert _project_json(cached.directory)["content_changed_at"] > before["content_changed_at"]


def test_a_fresh_store_on_the_same_directory_reads_the_draft_identically(
    store: ConversionStore,
) -> None:
    cached = _assigned(store)
    saved = store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    project = store.summary(cached.conversion_id)

    restarted = ConversionStore(root=store.root, ttl_seconds=3600, max_entries=10)
    reopened = restarted.get(cached.conversion_id)
    stored = restarted.draft(reopened)

    assert stored.revision == saved.revision
    assert stored.draft.model_dump(mode="json") == _draft()
    assert restarted.summary(cached.conversion_id).content_changed_at == project.content_changed_at
    assert not restarted.save_draft(cached.conversion_id, _model(_draft()), saved.revision).changed


@pytest.mark.parametrize("bad_id", INVALID_IDS)
def test_a_hostile_id_is_rejected_before_any_filesystem_call(
    tmp_path: Path, bad_id: str, request: pytest.FixtureRequest
) -> None:
    store = ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=3)
    calls = request.getfixturevalue("filesystem_calls")

    with pytest.raises(ConversionExpiredError):
        store.save_draft(bad_id, _model(_draft()), 0)

    assert calls == []


def test_saves_wait_for_the_per_id_lock(store: ConversionStore) -> None:
    cached = _assigned(store)
    revision = store.draft(cached).revision
    done = threading.Event()

    def save() -> None:
        store.save_draft(cached.conversion_id, _model(_draft()), revision)
        done.set()

    with store._lock_for(cached.conversion_id):
        worker = threading.Thread(target=save)
        worker.start()
        assert not done.wait(0.3), "a draft save must wait for the per-id lock"
    worker.join(5)
    assert done.is_set()


def test_concurrent_saves_from_one_revision_let_exactly_one_through(store: ConversionStore) -> None:
    cached = _assigned(store)
    revision = store.draft(cached).revision
    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def save(anchor: float) -> None:
        payload = _draft()
        payload["placement"]["floors"][0]["map_anchor"] = [anchor, 35.68]
        barrier.wait()
        try:
            store.save_draft(cached.conversion_id, _model(payload), revision)
            outcomes.append("saved")
        except DraftConflictError:
            outcomes.append("conflict")

    threads = [threading.Thread(target=save, args=(value,)) for value in (139.76, 139.77)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(outcomes) == ["conflict", "saved"]
    assert store.draft(cached).revision == revision + 1


def test_listing_never_reads_the_draft(store: ConversionStore, monkeypatch) -> None:
    cached = _assigned(store)
    store.save_draft(cached.conversion_id, _model(_draft()), store.draft(cached).revision)
    before = store.summary(cached.conversion_id)
    real_read_text = Path.read_text

    def guarded(self: Path, *args, **kwargs):
        if self.name == "placement.json":
            raise AssertionError("listing must not read the draft")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guarded)
    (summary,) = store.list_summaries()
    assert summary.conversion_id == cached.conversion_id
    assert store.summary(cached.conversion_id).content_changed_at == before.content_changed_at


# --- endpoints --------------------------------------------------------------


def _put_draft(test_client, conversion_id: str, draft: dict, base_revision: int):
    return test_client.put(
        f"/api/convert/illustrator/{conversion_id}/draft",
        json={"base_revision": base_revision, "draft": draft},
    )


def _assigned_client(test_client) -> tuple[str, int]:
    conversion_id = _preview(test_client).json()["conversion_id"]
    response = test_client.post(
        f"/api/convert/illustrator/{conversion_id}/assign", json=_assign_body()
    )
    assert response.status_code == 200, response.text
    return conversion_id, response.json()["draft_revision"]


def test_the_draft_round_trips_through_the_api(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    opened = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()
    assert (opened["draft"], opened["draft_revision"]) == (None, revision)

    response = _put_draft(test_client, conversion_id, _draft(), revision)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["revision"], body["changed"]) == (revision + 1, True)

    reopened = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()
    assert reopened["draft"] == _draft()
    assert reopened["draft_revision"] == revision + 1
    assert reopened["project"]["floors_placed"] == 1


def test_opening_a_project_is_not_an_edit(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    _put_draft(test_client, conversion_id, _draft(), revision)
    first = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]
    listed = test_client.get("/api/projects?flow=artwork").json()["projects"][0]

    again = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]
    relisted = test_client.get("/api/projects?flow=artwork").json()["projects"][0]
    resaved = _put_draft(test_client, conversion_id, _draft(), revision + 1).json()

    assert resaved["changed"] is False
    for key in ("updated_at", "content_changed_at", "stage", "blockers"):
        assert again[key] == first[key]
        assert resaved["project"][key] == first[key]
    assert relisted["updated_at"] == listed["updated_at"]


def test_a_no_op_save_after_export_keeps_the_delivery_current(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    saved = _put_draft(test_client, conversion_id, _draft(), revision).json()
    body = {
        "floors": [
            {
                "label": label,
                "transform": {
                    "artwork_anchor": [100.0, 100.0],
                    "map_anchor": [139.7671, 35.6812],
                    "rotation_deg": 0.0,
                    "metres_per_point": 0.35,
                    "working_crs": "EPSG:6677",
                },
            }
            for label in ("1F", "2F")
        ],
        "output_crs": "EPSG:6677",
        "formats": {"geopackage": False, "shapefile": True, "qgis": False},
    }
    assert test_client.post(
        f"/api/convert/illustrator/{conversion_id}/export", json=body
    ).status_code == 200

    again = _put_draft(test_client, conversion_id, _draft(), saved["revision"]).json()
    assert again["changed"] is False
    assert again["project"]["stage"] == "deliver"


def test_a_stale_save_is_409(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    assert _put_draft(test_client, conversion_id, _draft(), revision).status_code == 200
    response = _put_draft(test_client, conversion_id, _draft(), revision)
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "DRAFT_CONFLICT"


def _with(path: tuple, value) -> dict:
    draft = _draft()
    target = draft
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return draft


@pytest.mark.parametrize(
    "draft",
    [
        _with(("version",), 2),
        _with(("surprise",), True),
        _with(("placement", "floors"), []),
        _with(("placement", "floors"), [_floor(f"F{n}") for n in range(65)]),
        _with(("placement", "floors"), [_floor("1F"), _floor("1F")]),
        _with(("placement", "frame", "metres_per_point"), 0),
        _with(("placement", "frame", "working_crs"), "x" * 200),
        _with(("view", "station_pin"), [181.0, 35.0]),
        _with(("view", "station_pin"), [139.0, 91.0]),
        _with(("view", "mode"), "both"),
        _with(("view", "references", "hidden"), [f"layer {n}" for n in range(65)]),
    ],
)
def test_out_of_bounds_drafts_are_422(test_client, draft: dict) -> None:
    conversion_id, revision = _assigned_client(test_client)
    response = _put_draft(test_client, conversion_id, draft, revision)
    assert response.status_code == 422, response.text


def test_too_many_control_points_are_422(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    points = [{"id": str(n), "artwork": [0.0, 0.0], "map": [139.0, 35.0]} for n in range(101)]
    draft = _draft()
    draft["placement"]["floors"][0]["control_points"] = points
    assert _put_draft(test_client, conversion_id, draft, revision).status_code == 422


def test_non_finite_numbers_are_422(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    text = json.dumps({"base_revision": revision, "draft": _draft()}).replace("12.5", "NaN", 1)
    response = test_client.put(
        f"/api/convert/illustrator/{conversion_id}/draft",
        content=text,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text


def test_an_oversized_body_is_413_before_it_is_parsed(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    padding = " " * (MAX_DRAFT_BYTES + 1)
    response = test_client.put(
        f"/api/convert/illustrator/{conversion_id}/draft",
        content=json.dumps({"base_revision": revision, "draft": _draft()}) + padding,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413, response.text
    assert response.json()["code"] == "DRAFT_TOO_LARGE"


@pytest.mark.parametrize("encoded_id", [*_TRAVERSING_IDS, "0" * 32])
def test_a_hostile_or_unknown_id_is_404(test_client, encoded_id: str) -> None:
    response = _put_draft(test_client, encoded_id, _draft(), 0)
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CONVERSION_EXPIRED"


@pytest.mark.parametrize("encoded_id", _TRAVERSING_IDS)
def test_a_hostile_id_is_404_even_with_a_body_that_would_not_validate(
    test_client, encoded_id: str
) -> None:
    response = test_client.put(
        f"/api/convert/illustrator/{encoded_id}/draft", json={"base_revision": 0, "draft": {}}
    )
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CONVERSION_EXPIRED"


def test_a_delivered_project_opened_without_a_draft_stays_delivered(test_client) -> None:
    conversion_id, revision = _assigned_client(test_client)
    transform = {
        "artwork_anchor": [100.0, 100.0],
        "map_anchor": [139.7671, 35.6812],
        "rotation_deg": 0.0,
        "metres_per_point": 0.35,
        "working_crs": "EPSG:6677",
    }
    body = {"floors": [{"label": label, "transform": transform} for label in ("1F", "2F")]}
    assert test_client.post(
        f"/api/convert/illustrator/{conversion_id}/export", json=body
    ).status_code == 200
    delivered = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]

    response = test_client.put(
        f"/api/convert/illustrator/{conversion_id}/draft",
        json={"base_revision": revision, "draft": _draft(), "baseline": True},
    )
    assert response.status_code == 200, response.text
    assert response.json()["project"]["content_changed_at"] == delivered["content_changed_at"]
    listed = test_client.get("/api/projects?flow=artwork").json()["projects"][0]
    assert listed["stage"] == "deliver"
    assert listed["changed_since_delivery"] is False
