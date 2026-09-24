"""An artwork conversion as a reopenable, listable project."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.src.artwork_projects import derive_artwork_stage
from backend.src.illustrator_importer import PARSER_VERSION, parse_ai
from backend.src.illustrator_store import (
    ConversionExpiredError,
    ConversionStore,
    migrate_legacy_conversions,
)
from backend.tests.test_illustrator_api import _TRAVERSING_IDS, _assign_body, _body, _preview
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf

pytestmark = pytest.mark.georef

_FLOORS = [
    {"label": "1F", "box": [0.0, 0.0, 85.0, 200.0], "pages": None, "layer_names": None},
    {"label": "2F", "box": [85.0, 0.0, 200.0, 200.0], "pages": None, "layer_names": None},
]


@pytest.fixture()
def store(tmp_path: Path) -> ConversionStore:
    return ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=10)


def _put(store: ConversionStore, name: str = "sample.ai"):
    return store.put(parse_ai(_build_minimal_ai_pdf(), name))


def _set_last_used(directory: Path, when: float) -> None:
    os.utime(directory / "last_used", (when, when))


def _project_json(directory: Path) -> dict:
    return json.loads((directory / "project.json").read_text(encoding="utf-8"))


# --- list_summaries -------------------------------------------------------


def test_list_does_not_touch_or_discard(store: ConversionStore, monkeypatch) -> None:
    live = _put(store, "live.ai")
    stale = _put(store, "stale.ai")
    corrupt = store.root / ("c" * 32)
    corrupt.mkdir()
    (corrupt / "conversion.json").write_text("not json", encoding="utf-8")

    earlier = time.time() - 600
    _set_last_used(live.directory, earlier)
    _set_last_used(stale.directory, time.time() - 7200)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("list_summaries must not call get()")

    monkeypatch.setattr(ConversionStore, "get", forbidden)
    summaries = store.list_summaries()

    assert [s.conversion_id for s in summaries] == [live.conversion_id]
    assert (live.directory / "last_used").stat().st_mtime == pytest.approx(earlier)
    assert stale.directory.is_dir()
    assert (corrupt / "conversion.json").is_file()


@pytest.mark.parametrize("vanishing_file", ["conversion.json", "project.json"])
def test_list_skips_an_entry_removed_mid_read(
    store: ConversionStore, monkeypatch, vanishing_file: str
) -> None:
    kept = _put(store, "kept.ai")
    doomed = _put(store, "doomed.ai")
    real_read_text = Path.read_text

    def read_text(self: Path, *args, **kwargs):
        if self.parent == doomed.directory and self.name == vanishing_file:
            shutil.rmtree(doomed.directory)
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    summaries = store.list_summaries()

    assert [s.conversion_id for s in summaries] == [kept.conversion_id]


def test_list_ignores_directories_that_are_not_conversion_ids(store: ConversionStore) -> None:
    _put(store)
    stray = store.root / "not-an-id"
    stray.mkdir()
    (stray / "conversion.json").write_text("{}", encoding="utf-8")
    assert len(store.list_summaries()) == 1


def test_list_reports_name_stage_and_blockers(store: ConversionStore) -> None:
    cached = _put(store, "新宿駅.ai")
    (summary,) = store.list_summaries()
    assert summary.name == "新宿駅"
    assert (summary.stage, summary.blockers) == ("name-floors", None)
    assert summary.delivered_at is None

    store.assign(cached.conversion_id, _FLOORS)
    store.rename(cached.conversion_id, "Shinjuku")
    (summary,) = store.list_summaries()
    assert summary.name == "Shinjuku"
    assert (summary.floors_total, summary.floors_placed) == (2, 0)
    assert (summary.stage, summary.blockers) == ("place", 2)
    assert summary.parser_version == PARSER_VERSION


# --- sidecar ----------------------------------------------------------------


def test_put_writes_a_default_project_and_the_parser_version(store: ConversionStore) -> None:
    cached = _put(store, "sample.ai")
    project = _project_json(cached.directory)
    assert project["name"] == "sample"
    assert project["delivered_at"] is None
    assert (project["floors_total"], project["floors_placed"]) == (0, 0)
    assert project["updated_at"]
    meta = json.loads((cached.directory / "conversion.json").read_text(encoding="utf-8"))
    assert meta["parser_version"] == PARSER_VERSION
    assert store.get(cached.conversion_id).parser_version == PARSER_VERSION


def test_rename_trims_and_rejects_blank_or_long_names(store: ConversionStore) -> None:
    cached = _put(store)
    assert store.rename(cached.conversion_id, "  Tokyo B1  ").name == "Tokyo B1"
    assert _project_json(cached.directory)["name"] == "Tokyo B1"
    with pytest.raises(ValueError):
        store.rename(cached.conversion_id, "   ")
    with pytest.raises(ValueError):
        store.rename(cached.conversion_id, "x" * 121)
    with pytest.raises(ConversionExpiredError):
        store.rename("0" * 32, "name")


@pytest.mark.parametrize(
    "spoof",
    [
        "invoice‮gpj.ai",  # RIGHT-TO-LEFT OVERRIDE
        "Tokyo‍B1",  # ZERO WIDTH JOINER
        "Tokyo​B1",  # ZERO WIDTH SPACE
        "﻿Tokyo",  # BYTE ORDER MARK
        "Tokyo⁦B1⁩",  # bidi isolates
        "Tokyo\tB1",
        "Tokyo\nB1",
        "Tokyo B1",  # LINE SEPARATOR
        "TokyoㅤB1",  # HANGUL FILLER
    ],
)
def test_names_with_invisible_characters_are_rejected(store: ConversionStore, spoof: str) -> None:
    cached = _put(store)
    with pytest.raises(ValueError, match="invisible or control"):
        store.rename(cached.conversion_id, spoof)
    assert _project_json(cached.directory)["name"] == "sample"


def test_ordinary_names_are_kept(store: ConversionStore) -> None:
    cached = _put(store)
    for name in ("東京駅　B1", "Tokyo — B1 (v2)", "Café"):
        assert store.rename(cached.conversion_id, name).name == name


def test_concurrent_rename_and_assign_both_persist(store: ConversionStore) -> None:
    cached = _put(store)
    for round_number in range(25):
        barrier = threading.Barrier(2)
        errors: list[BaseException] = []
        floors = _FLOORS[: 1 + round_number % 2]

        def rename(name: str = f"name {round_number}") -> None:
            try:
                barrier.wait()
                store.rename(cached.conversion_id, name)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def assign(chosen: list[dict] = floors) -> None:
            try:
                barrier.wait()
                store.assign(cached.conversion_id, chosen)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=rename), threading.Thread(target=assign)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert errors == []
        project = _project_json(cached.directory)
        assert project["name"] == f"name {round_number}"
        assert project["floors_total"] == len(floors)


def test_sidecar_writes_are_serialised_per_conversion(store: ConversionStore, monkeypatch) -> None:
    cached = _put(store)
    import backend.src.illustrator_store as module

    real_read = module._read_project
    inside = threading.Event()
    release = threading.Event()

    def slow_read(directory: Path, stem: str, **kwargs):
        project = real_read(directory, stem, **kwargs)
        if threading.current_thread().name == "slow":
            inside.set()
            release.wait(5)
        return project

    monkeypatch.setattr(module, "_read_project", slow_read)
    slow = threading.Thread(target=store.rename, args=(cached.conversion_id, "first"), name="slow")
    slow.start()
    assert inside.wait(5)
    fast = threading.Thread(target=store.assign, args=(cached.conversion_id, _FLOORS))
    fast.start()
    fast.join(0.3)
    assert fast.is_alive(), "assign must wait for the in-flight rename"
    release.set()
    slow.join()
    fast.join()
    project = _project_json(cached.directory)
    assert (project["name"], project["floors_total"]) == ("first", 2)


def test_assign_resets_placed_floors(store: ConversionStore) -> None:
    cached = _put(store)
    store.assign(cached.conversion_id, _FLOORS)
    _, snapshot = store.open_for_export(cached.conversion_id)
    assert store.mark_delivered(cached.conversion_id, 2, snapshot) is not None
    store.assign(cached.conversion_id, _FLOORS[:1])
    project = _project_json(cached.directory)
    assert (project["floors_total"], project["floors_placed"]) == (1, 0)
    (summary,) = store.list_summaries()
    assert (summary.stage, summary.blockers) == ("place", 1)
    assert summary.delivered_at == project["delivered_at"]


def test_rename_after_delivery_keeps_it_current(store: ConversionStore) -> None:
    cached = _put(store)
    store.assign(cached.conversion_id, _FLOORS)
    _, snapshot = store.open_for_export(cached.conversion_id)
    store.mark_delivered(cached.conversion_id, 2, snapshot)
    store.rename(cached.conversion_id, "renamed")
    (summary,) = store.list_summaries()
    assert (summary.stage, summary.blockers) == ("deliver", 0)


def test_an_assignment_during_export_is_not_marked_delivered(store: ConversionStore) -> None:
    cached = _put(store)
    store.assign(cached.conversion_id, _FLOORS)
    _, snapshot = store.open_for_export(cached.conversion_id)
    store.assign(cached.conversion_id, _FLOORS)

    assert store.mark_delivered(cached.conversion_id, 2, snapshot) is None
    project = _project_json(cached.directory)
    assert project["delivered_at"] is None
    assert project["floors_placed"] == 0


# --- robustness -------------------------------------------------------------


def _vanish_on_sidecar_read(monkeypatch, directory: Path) -> None:
    import backend.src.illustrator_store as module

    real_read = module._read_project

    def read_then_vanish(target: Path, stem: str, **kwargs):
        project = real_read(target, stem, **kwargs)
        shutil.rmtree(directory)
        return project

    monkeypatch.setattr(module, "_read_project", read_then_vanish)


@pytest.mark.parametrize("operation", ["rename", "assign"])
def test_a_write_after_the_entry_was_discarded_is_not_found(
    store: ConversionStore, monkeypatch, operation: str
) -> None:
    cached = _put(store)
    _vanish_on_sidecar_read(monkeypatch, cached.directory)
    with pytest.raises(ConversionExpiredError):
        if operation == "rename":
            store.rename(cached.conversion_id, "gone")
        else:
            store.assign(cached.conversion_id, _FLOORS)


def _lock_project_json(monkeypatch, failures: int | None) -> list[int]:
    real_read_text = Path.read_text
    calls: list[int] = []

    def read_text(self: Path, *args, **kwargs):
        if self.name == "project.json":
            calls.append(1)
            if failures is None or len(calls) <= failures:
                raise PermissionError(13, "locked", str(self))
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    return calls


def test_a_briefly_locked_sidecar_is_retried(store: ConversionStore, monkeypatch) -> None:
    cached = _put(store)
    store.rename(cached.conversion_id, "kept")
    calls = _lock_project_json(monkeypatch, failures=2)
    assert store.project(store.get(cached.conversion_id)).name == "kept"
    assert len(calls) == 3


def test_a_stuck_sidecar_lock_never_overwrites_the_project(
    store: ConversionStore, monkeypatch
) -> None:
    from backend.src.illustrator_store import ConversionBusyError

    cached = _put(store)
    store.rename(cached.conversion_id, "kept")
    _lock_project_json(monkeypatch, failures=None)
    assert store.project(store.get(cached.conversion_id)).name == "sample"
    with pytest.raises(ConversionBusyError):
        store.assign(cached.conversion_id, _FLOORS)
    monkeypatch.undo()
    assert _project_json(cached.directory)["name"] == "kept"
    assert not (cached.directory / "floors.json").exists()


# --- stage ------------------------------------------------------------------


_EARLIER = "2026-09-25T00:00:00.000000+00:00"
_DELIVERED = "2026-09-25T01:00:00.000000+00:00"
_LATER = "2026-09-25T02:00:00.000000+00:00"


@pytest.mark.parametrize(
    ("has_floors", "total", "placed", "delivered_at", "changed_at", "expected"),
    [
        (False, 0, 0, None, _EARLIER, ("name-floors", None)),
        (True, 2, 0, None, _EARLIER, ("place", 2)),
        (True, 3, 1, None, _EARLIER, ("place", 2)),
        (True, 2, 2, None, _EARLIER, ("deliver", 0)),
        (True, 2, 3, None, _EARLIER, ("deliver", 0)),
        (True, 0, 0, None, _EARLIER, ("place", None)),
        (True, 2, 2, _DELIVERED, _EARLIER, ("deliver", 0)),
        (True, 2, 2, _DELIVERED, _DELIVERED, ("deliver", 0)),
        (False, 0, 0, _DELIVERED, None, ("deliver", 0)),
        # Floors reassigned after the export: the delivery is stale.
        (True, 2, 0, _DELIVERED, _LATER, ("place", 2)),
        (False, 0, 0, _DELIVERED, _LATER, ("name-floors", None)),
        (True, 2, 2, _DELIVERED, _LATER, ("deliver", 0)),
    ],
)
def test_artwork_stage_table(has_floors, total, placed, delivered_at, changed_at, expected) -> None:
    assert (
        derive_artwork_stage(
            has_floors=has_floors,
            floors_total=total,
            floors_placed=placed,
            delivered_at=delivered_at,
            content_changed_at=changed_at,
        )
        == expected
    )


# --- store root migration -------------------------------------------------


def test_legacy_entries_move_to_the_durable_root(tmp_path: Path) -> None:
    legacy = tmp_path / "tmp" / "illustrator"
    old = ConversionStore(root=legacy, ttl_seconds=3600, max_entries=10)
    cached = old.put(parse_ai(_build_minimal_ai_pdf(), "legacy.ai"))
    old.assign(cached.conversion_id, _FLOORS)
    (legacy / "not-an-id").mkdir()

    durable = tmp_path / "illustrator"
    assert migrate_legacy_conversions(legacy, durable) == 1

    store = ConversionStore(root=durable, ttl_seconds=3600, max_entries=10)
    moved = store.get(cached.conversion_id)
    assert moved.floors == _FLOORS
    assert moved.gpkg_path.is_file()
    assert not (legacy / cached.conversion_id).exists()
    assert (legacy / "not-an-id").is_dir()
    assert migrate_legacy_conversions(legacy, durable) == 0


def test_migration_keeps_an_entry_already_in_the_durable_root(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    cached = ConversionStore(root=legacy, ttl_seconds=3600, max_entries=10).put(
        parse_ai(_build_minimal_ai_pdf(), "a.ai")
    )
    (durable / cached.conversion_id).mkdir(parents=True)
    (durable / cached.conversion_id / "keep.txt").write_text("keep", encoding="utf-8")

    assert migrate_legacy_conversions(legacy, durable) == 0
    assert (durable / cached.conversion_id / "keep.txt").is_file()
    assert (legacy / cached.conversion_id).is_dir()


def _force_cross_drive(monkeypatch, legacy: Path) -> None:
    real_rename = os.rename

    def rename(source, target):
        if Path(source).parent == legacy:
            raise OSError(18, "Invalid cross-device link", str(source))
        return real_rename(source, target)

    monkeypatch.setattr(os, "rename", rename)


def test_a_cross_drive_migration_copies_then_renames(monkeypatch, tmp_path: Path) -> None:
    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    cached = ConversionStore(root=legacy, ttl_seconds=3600, max_entries=10).put(
        parse_ai(_build_minimal_ai_pdf(), "a.ai")
    )
    _force_cross_drive(monkeypatch, legacy)

    assert migrate_legacy_conversions(legacy, durable) == 1
    assert not legacy.exists()
    assert [entry.name for entry in durable.iterdir()] == [cached.conversion_id]
    store = ConversionStore(root=durable, ttl_seconds=3600, max_entries=10)
    assert store.get(cached.conversion_id).gpkg_path.is_file()


def test_an_interrupted_copy_leaves_no_entry_under_the_real_id(
    monkeypatch, tmp_path: Path
) -> None:
    legacy = tmp_path / "legacy"
    durable = tmp_path / "durable"
    cached = ConversionStore(root=legacy, ttl_seconds=3600, max_entries=10).put(
        parse_ai(_build_minimal_ai_pdf(), "a.ai")
    )
    _force_cross_drive(monkeypatch, legacy)

    def partial_copy(source, target, *args, **kwargs):
        Path(target).mkdir(parents=True)
        shutil.copy2(Path(source) / "conversion.json", Path(target) / "conversion.json")
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(shutil, "copytree", partial_copy)

    assert migrate_legacy_conversions(legacy, durable) == 0
    assert list(durable.iterdir()) == []
    assert (legacy / cached.conversion_id / "artwork.gpkg").is_file()

    monkeypatch.undo()
    assert migrate_legacy_conversions(legacy, durable) == 1
    store = ConversionStore(root=durable, ttl_seconds=3600, max_entries=10)
    assert store.get(cached.conversion_id).gpkg_path.is_file()


def test_startup_removes_a_copy_left_by_a_crash(tmp_path: Path) -> None:
    durable = tmp_path / "durable"
    leftover = durable / f".{'a' * 32}.{'b' * 32}.migrating"
    leftover.mkdir(parents=True)
    (leftover / "conversion.json").write_text("{}", encoding="utf-8")
    kept = durable / ("c" * 32)
    kept.mkdir()

    migrate_legacy_conversions(tmp_path / "missing", durable)

    assert not leftover.exists()
    assert kept.is_dir()


def test_migration_without_a_legacy_root_is_a_no_op(tmp_path: Path) -> None:
    assert migrate_legacy_conversions(tmp_path / "missing", tmp_path / "durable") == 0


def test_startup_moves_the_temp_store_into_the_data_dir(monkeypatch, tmp_path: Path) -> None:
    from backend.main import app

    legacy = tmp_path / "tmp" / "illustrator"
    cached = ConversionStore(root=legacy, ttl_seconds=3600, max_entries=10).put(
        parse_ai(_build_minimal_ai_pdf(), "legacy.ai")
    )
    monkeypatch.setenv("SESSION_DATA_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("SESSION_UPLOADS_DIR", str(tmp_path / "session_uploads"))
    monkeypatch.setenv("TEMP_DATA_DIR", str(tmp_path / "tmp"))
    monkeypatch.setenv("PLACEMENTS_DB", str(tmp_path / "placements.db"))
    monkeypatch.setenv("ILLUSTRATOR_DATA_DIR", str(tmp_path / "artwork"))

    with TestClient(app) as client:
        store = client.app.state.illustrator_store
        assert store.root == tmp_path / "artwork"
        assert store.get(cached.conversion_id).gpkg_path.is_file()

    assert not legacy.exists()


# --- endpoints --------------------------------------------------------------


def test_get_conversion_returns_preview_floors_and_project(test_client) -> None:
    preview = _preview(test_client).json()
    conversion_id = preview["conversion_id"]

    first = test_client.get(f"/api/convert/illustrator/{conversion_id}")
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["preview"] == preview
    assert data["floors"] is None
    assert data["project"]["name"] == "sample"
    assert (data["project"]["stage"], data["project"]["blockers"]) == ("name-floors", None)

    assert test_client.post(
        f"/api/convert/illustrator/{conversion_id}/assign", json=_assign_body()
    ).status_code == 200
    data = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()
    assert [floor["label"] for floor in data["floors"]] == ["1F", "2F"]
    assert data["floors"][0]["box"] == _assign_body()["floors"][0]["box"]
    assert data["project"]["floors_total"] == 2
    assert (data["project"]["stage"], data["project"]["blockers"]) == ("place", 2)


@pytest.mark.parametrize("encoded_id", [*_TRAVERSING_IDS, "0" * 32])
def test_get_and_patch_an_unknown_or_invalid_id_are_404(test_client, encoded_id: str) -> None:
    for response in (
        test_client.get(f"/api/convert/illustrator/{encoded_id}"),
        test_client.patch(f"/api/convert/illustrator/{encoded_id}", json={"name": "x"}),
    ):
        assert response.status_code == 404, response.text
        assert response.json()["code"] == "CONVERSION_EXPIRED"


def test_patch_renames_the_project(test_client) -> None:
    conversion_id = _preview(test_client).json()["conversion_id"]
    response = test_client.patch(
        f"/api/convert/illustrator/{conversion_id}", json={"name": "  東京駅 B1  "}
    )
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "東京駅 B1"
    assert test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"][
        "name"
    ] == "東京駅 B1"

    for bad in ("   ", "x" * 121):
        rejected = test_client.patch(f"/api/convert/illustrator/{conversion_id}", json={"name": bad})
        assert rejected.status_code == 400, rejected.text
    assert test_client.patch(
        f"/api/convert/illustrator/{conversion_id}", json={"name": "a", "extra": 1}
    ).status_code == 422


def test_export_sets_delivered_at(test_client) -> None:
    preview = _preview(test_client).json()
    conversion_id = preview["conversion_id"]
    assert test_client.post(
        f"/api/convert/illustrator/{conversion_id}/assign", json=_assign_body()
    ).status_code == 200
    body = _body(preview["artwork_bounds"])
    body["floors"] = [
        {"label": label, "transform": body["floors"][0]["transform"]} for label in ("1F", "2F")
    ]
    before = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]
    assert before["delivered_at"] is None

    response = test_client.post(f"/api/convert/illustrator/{conversion_id}/export", json=body)
    assert response.status_code == 200, response.text

    after = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]
    assert after["delivered_at"] is not None
    assert (after["floors_total"], after["floors_placed"]) == (2, 2)
    assert (after["stage"], after["blockers"]) == ("deliver", 0)


def test_a_failed_export_does_not_mark_delivery(test_client) -> None:
    preview = _preview(test_client).json()
    conversion_id = preview["conversion_id"]
    body = _body(preview["artwork_bounds"])
    body["formats"] = {"geopackage": False, "shapefile": False, "qgis": False}
    assert test_client.post(
        f"/api/convert/illustrator/{conversion_id}/export", json=body
    ).status_code == 400
    project = test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]
    assert project["delivered_at"] is None


def _two_floor_export(test_client, preview: dict):
    conversion_id = preview["conversion_id"]
    body = _body(preview["artwork_bounds"])
    body["floors"] = [
        {"label": label, "transform": body["floors"][0]["transform"]} for label in ("1F", "2F")
    ]
    return test_client.post(f"/api/convert/illustrator/{conversion_id}/export", json=body)


def _assign(test_client, conversion_id: str) -> None:
    response = test_client.post(
        f"/api/convert/illustrator/{conversion_id}/assign", json=_assign_body()
    )
    assert response.status_code == 200, response.text


def _project(test_client, conversion_id: str) -> dict:
    return test_client.get(f"/api/convert/illustrator/{conversion_id}").json()["project"]


def test_reassigning_after_export_reopens_placement(test_client) -> None:
    preview = _preview(test_client).json()
    conversion_id = preview["conversion_id"]
    _assign(test_client, conversion_id)
    assert _two_floor_export(test_client, preview).status_code == 200
    delivered = _project(test_client, conversion_id)
    assert delivered["stage"] == "deliver"

    _assign(test_client, conversion_id)
    project = _project(test_client, conversion_id)
    assert project["delivered_at"] == delivered["delivered_at"]
    assert project["content_changed_at"] > delivered["delivered_at"]
    assert (project["stage"], project["blockers"]) == ("place", 2)


def test_an_assignment_landing_mid_export_is_not_marked_delivered(
    test_client, monkeypatch
) -> None:
    import backend.routers.import_router as router_module

    preview = _preview(test_client).json()
    conversion_id = preview["conversion_id"]
    _assign(test_client, conversion_id)
    real_build = router_module.build_georeferenced_bundle

    def build_while_reassigned(*args, **kwargs):
        result = real_build(*args, **kwargs)
        test_client.app.state.illustrator_store.assign(conversion_id, _FLOORS)
        return result

    monkeypatch.setattr(router_module, "build_georeferenced_bundle", build_while_reassigned)
    assert _two_floor_export(test_client, preview).status_code == 200

    project = _project(test_client, conversion_id)
    assert project["delivered_at"] is None
    assert (project["stage"], project["blockers"]) == ("place", 2)


def test_a_failed_delivery_mark_still_returns_the_export(test_client, monkeypatch) -> None:
    preview = _preview(test_client).json()
    _assign(test_client, preview["conversion_id"])
    store = test_client.app.state.illustrator_store

    def broken(*_args, **_kwargs):
        raise OSError("disk went away")

    monkeypatch.setattr(store, "mark_delivered", broken)
    response = _two_floor_export(test_client, preview)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"


@pytest.mark.parametrize("spoof", ["abc‮txt.exe", "東京‍駅"])
def test_patch_rejects_names_that_spoof_rendering(test_client, spoof: str) -> None:
    conversion_id = _preview(test_client).json()["conversion_id"]
    response = test_client.patch(f"/api/convert/illustrator/{conversion_id}", json={"name": spoof})
    assert response.status_code == 400, response.text
    assert _project(test_client, conversion_id)["name"] == "sample"


def test_patch_on_an_entry_discarded_mid_write_is_404(test_client, monkeypatch) -> None:
    conversion_id = _preview(test_client).json()["conversion_id"]
    store = test_client.app.state.illustrator_store
    _vanish_on_sidecar_read(monkeypatch, store.root / conversion_id)
    response = test_client.patch(f"/api/convert/illustrator/{conversion_id}", json={"name": "x"})
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CONVERSION_EXPIRED"


def test_a_locked_sidecar_is_503_on_patch_and_defaults_on_get(test_client, monkeypatch) -> None:
    conversion_id = _preview(test_client).json()["conversion_id"]
    _lock_project_json(monkeypatch, failures=None)
    response = test_client.patch(f"/api/convert/illustrator/{conversion_id}", json={"name": "x"})
    assert response.status_code == 503, response.text
    assert response.json()["code"] == "CONVERSION_BUSY"
    reopened = test_client.get(f"/api/convert/illustrator/{conversion_id}")
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["project"]["name"] == "sample"
