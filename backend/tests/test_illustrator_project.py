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

    def slow_read(directory: Path, stem: str):
        project = real_read(directory, stem)
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
    store.mark_delivered(cached.conversion_id, floors_placed=2)
    store.assign(cached.conversion_id, _FLOORS[:1])
    project = _project_json(cached.directory)
    assert (project["floors_total"], project["floors_placed"]) == (1, 0)


# --- stage ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("has_floors", "total", "placed", "delivered_at", "expected"),
    [
        (False, 0, 0, None, ("name-floors", None)),
        (True, 2, 0, None, ("place", 2)),
        (True, 3, 1, None, ("place", 2)),
        (True, 2, 2, None, ("deliver", 0)),
        (True, 2, 3, None, ("deliver", 0)),
        (True, 0, 0, None, ("place", None)),
        (False, 0, 0, "2026-09-25T00:00:00+00:00", ("deliver", 0)),
        (True, 2, 0, "2026-09-25T00:00:00+00:00", ("deliver", 0)),
    ],
)
def test_artwork_stage_table(has_floors, total, placed, delivered_at, expected) -> None:
    assert (
        derive_artwork_stage(
            has_floors=has_floors,
            floors_total=total,
            floors_placed=placed,
            delivered_at=delivered_at,
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
