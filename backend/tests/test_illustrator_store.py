"""Cached-conversion store tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.src.illustrator_importer import parse_ai
from backend.src.illustrator_store import ConversionExpiredError, ConversionStore
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf


@pytest.fixture()
def store(tmp_path: Path) -> ConversionStore:
    return ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=3)


_DAY = 24 * 3600


class _FakeClock:
    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def time(self) -> float:
        return self.now


@pytest.fixture()
def clock(monkeypatch: pytest.MonkeyPatch) -> _FakeClock:
    fake = _FakeClock()
    monkeypatch.setattr("backend.src.illustrator_store.time", fake)
    return fake


@pytest.mark.georef
def test_put_then_get_round_trips_a_conversion(store: ConversionStore) -> None:
    result = parse_ai(_build_minimal_ai_pdf(), "sample.ai")
    cached = store.put(result)

    fetched = store.get(cached.conversion_id)
    assert fetched.stem == "sample"
    assert fetched.gpkg_path.exists()
    assert fetched.gpkg_path.read_bytes() == result.gpkg_bytes
    assert fetched.written_layers == result.written_layers
    assert fetched.report["total_features"] == result.report.total_features


@pytest.mark.georef
def test_unknown_id_raises_expired(store: ConversionStore) -> None:
    with pytest.raises(ConversionExpiredError):
        store.get("does-not-exist")


@pytest.mark.georef
def test_expired_entry_raises_and_is_removed(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=-1, max_entries=3)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    with pytest.raises(ConversionExpiredError):
        store.get(cached.conversion_id)
    assert not cached.directory.exists()


@pytest.mark.georef
def test_oldest_entries_are_evicted_beyond_the_cap(tmp_path: Path, clock: _FakeClock) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * _DAY, max_entries=3)
    payload = _build_minimal_ai_pdf()
    first = store.put(parse_ai(payload, "one.ai"))
    for name in ("two.ai", "three.ai", "four.ai"):
        clock.now += _DAY
        store.put(parse_ai(payload, name))

    with pytest.raises(ConversionExpiredError):
        store.get(first.conversion_id)
    assert not first.directory.exists()


@pytest.mark.georef
def test_prune_reports_how_many_it_removed(tmp_path: Path) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=-1, max_entries=10)
    payload = _build_minimal_ai_pdf()
    store.put(parse_ai(payload, "one.ai"))
    store.put(parse_ai(payload, "two.ai"))
    assert store.prune() == 2
    assert store.prune() == 0


FLOORS = [
    {"label": "1F", "box": [0.0, 0.0, 200.0, 200.0], "layer_names": None},
    {"label": "2F", "box": [200.0, 0.0, 400.0, 200.0], "layer_names": ["壁"]},
]


@pytest.mark.georef
def test_new_conversions_have_no_assignment(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    assert cached.floors is None


@pytest.mark.georef
def test_assign_stores_and_round_trips_floors(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    stored = store.assign(cached.conversion_id, FLOORS)
    assert stored.floors == FLOORS

    fetched = store.get(cached.conversion_id)
    assert fetched.floors == FLOORS


@pytest.mark.georef
def test_assign_replaces_a_previous_assignment(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, FLOORS)
    replaced = store.assign(cached.conversion_id, [FLOORS[0]])
    assert replaced.floors == [FLOORS[0]]


@pytest.mark.georef
def test_assign_to_an_unknown_id_raises(store: ConversionStore) -> None:
    with pytest.raises(ConversionExpiredError):
        store.assign("does-not-exist", FLOORS)


@pytest.mark.georef
def test_prune_removes_the_floors_file_too(tmp_path: Path, clock: _FakeClock) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=3600, max_entries=10)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    store.assign(cached.conversion_id, FLOORS)
    assert (cached.directory / "floors.json").exists()

    clock.now += 7200

    assert store.prune() == 1
    assert not cached.directory.exists()


@pytest.mark.georef
def test_get_keeps_a_conversion_alive_past_its_creation_ttl(
    tmp_path: Path, clock: _FakeClock
) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=100, max_entries=3)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    clock.now += 80
    store.get(cached.conversion_id)
    clock.now += 80
    assert store.get(cached.conversion_id).stem == "sample"
    assert store.prune() == 0


@pytest.mark.georef
def test_assign_keeps_a_conversion_alive(tmp_path: Path, clock: _FakeClock) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=100, max_entries=3)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    clock.now += 80
    store.assign(cached.conversion_id, FLOORS)
    clock.now += 80
    assert store.get(cached.conversion_id).floors == FLOORS


@pytest.mark.georef
def test_an_idle_conversion_still_expires(tmp_path: Path, clock: _FakeClock) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=100, max_entries=3)
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    clock.now += 80
    store.get(cached.conversion_id)
    clock.now += 101
    with pytest.raises(ConversionExpiredError):
        store.get(cached.conversion_id)


@pytest.mark.georef
def test_the_cap_evicts_the_least_recently_used_entry(
    tmp_path: Path, clock: _FakeClock
) -> None:
    store = ConversionStore(root=tmp_path, ttl_seconds=30 * _DAY, max_entries=3)
    payload = _build_minimal_ai_pdf()
    entries = []
    for name in ("one.ai", "two.ai", "three.ai"):
        entries.append(store.put(parse_ai(payload, name)))
        clock.now += _DAY
    store.get(entries[0].conversion_id)
    clock.now += _DAY
    store.put(parse_ai(payload, "four.ai"))

    assert store.get(entries[0].conversion_id).stem == "one"
    with pytest.raises(ConversionExpiredError):
        store.get(entries[1].conversion_id)


def _plant_expired_entry(directory: Path) -> Path:
    """Write something shaped like an expired cache entry, outside the store."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "conversion.json").write_text(
        '{"conversion_id": "x", "stem": "s", "written_layers": [], "layer_order": [],'
        ' "report": {}, "created_at": 0}',
        encoding="utf-8",
    )
    (directory / "keep.txt").write_text("not the store's to delete", encoding="utf-8")
    return directory


INVALID_IDS = [
    "..",
    ".",
    "",
    "../victim",
    "..\\victim",
    "/etc",
    "C:\\Windows",
    "C:/Windows",
    "\\\\attacker.invalid\\share",
    "\\\\host.invalid\\x",
    "//attacker.invalid/share",
    "%2e%2e",
    "%5C%5Cattacker.invalid%5Cshare",
    "0123456789ABCDEF0123456789ABCDEF",
    "0123456789abcDEF0123456789abcdef",
    "0123456789abcdef0123456789abcdeg",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
    "0123456789abcdef0123456789abcdef/..",
    "0123456789abcdef0123456789abcdef\n",
    "a" * 4096,
]


@pytest.mark.georef
@pytest.mark.parametrize("bad_id", INVALID_IDS)
def test_invalid_ids_are_not_found_and_touch_nothing(tmp_path: Path, bad_id: str) -> None:
    root = tmp_path / "store"
    store = ConversionStore(root=root, ttl_seconds=-1, max_entries=3)
    victim = _plant_expired_entry(tmp_path / "victim")
    _plant_expired_entry(tmp_path)

    with pytest.raises(ConversionExpiredError):
        store.get(bad_id)
    with pytest.raises(ConversionExpiredError):
        store.assign(bad_id, FLOORS)

    assert root.is_dir()
    assert (victim / "keep.txt").is_file()
    assert (tmp_path / "keep.txt").is_file()
    assert not (tmp_path / "floors.json").exists()
    assert not (victim / "floors.json").exists()


@pytest.fixture()
def filesystem_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Record every stat, realpath, open, mkdir, utime and rmtree made."""
    calls: list[tuple[str, str]] = []

    def spy(name: str, real):
        def wrapper(path, *args, **kwargs):
            calls.append((name, str(path)))
            return real(path, *args, **kwargs)

        return wrapper

    import builtins
    import io
    import os
    import shutil

    for owner, name in [
        (os, "stat"),
        (os, "lstat"),
        (os, "mkdir"),
        (os, "utime"),
        (os, "open"),
        (os.path, "realpath"),
        (io, "open"),
        (builtins, "open"),
        (shutil, "rmtree"),
    ]:
        monkeypatch.setattr(owner, name, spy(name, getattr(owner, name)))
    return calls


@pytest.mark.georef
@pytest.mark.parametrize("bad_id", INVALID_IDS)
def test_invalid_ids_are_rejected_before_any_filesystem_call(
    tmp_path: Path, bad_id: str, request: pytest.FixtureRequest
) -> None:
    store = ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=3)
    calls = request.getfixturevalue("filesystem_calls")

    with pytest.raises(ConversionExpiredError):
        store.get(bad_id)
    with pytest.raises(ConversionExpiredError):
        store.assign(bad_id, FLOORS)

    assert calls == []


@pytest.mark.georef
def test_the_filesystem_spy_sees_a_valid_lookup(
    tmp_path: Path, request: pytest.FixtureRequest
) -> None:
    store = ConversionStore(root=tmp_path / "store", ttl_seconds=3600, max_entries=3)
    calls = request.getfixturevalue("filesystem_calls")
    with pytest.raises(ConversionExpiredError):
        store.get("0123456789abcdef0123456789abcdef")
    assert calls


@pytest.mark.georef
def test_a_corrupt_entry_is_not_found_and_removed(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    (cached.directory / "conversion.json").write_text("not json", encoding="utf-8")
    with pytest.raises(ConversionExpiredError):
        store.get(cached.conversion_id)
    assert not cached.directory.exists()
    assert store.root.is_dir()


def _locked_meta(monkeypatch: pytest.MonkeyPatch) -> None:
    real_read_text = Path.read_text

    def read_text(self: Path, *args, **kwargs):
        if self.name == "conversion.json":
            raise PermissionError(32, "The process cannot access the file", str(self))
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)


@pytest.mark.georef
def test_a_locked_entry_is_unavailable_but_kept(
    store: ConversionStore, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    with monkeypatch.context() as patch:
        _locked_meta(patch)
        with caplog.at_level("WARNING", logger="backend.src.illustrator_store"):
            with pytest.raises(ConversionExpiredError):
                store.get(cached.conversion_id)
            with pytest.raises(ConversionExpiredError):
                store.assign(cached.conversion_id, FLOORS)
            store.prune()
            store.put(parse_ai(_build_minimal_ai_pdf(), "other.ai"))

    assert (cached.directory / "conversion.json").is_file()
    assert any(cached.conversion_id in record.getMessage() for record in caplog.records)
    assert store.get(cached.conversion_id).stem == "sample"


@pytest.mark.georef
def test_generated_ids_match_the_accepted_format(store: ConversionStore) -> None:
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))
    assert len(cached.conversion_id) == 32
    assert store.get(cached.conversion_id).conversion_id == cached.conversion_id
    assert store.assign(cached.conversion_id, FLOORS).floors == FLOORS


@pytest.mark.georef
def test_discard_refuses_anything_but_a_direct_child_of_the_root(tmp_path: Path) -> None:
    root = tmp_path / "store"
    store = ConversionStore(root=root, ttl_seconds=3600, max_entries=3)
    outside = _plant_expired_entry(tmp_path / "outside")
    nested = _plant_expired_entry(root / "0123456789abcdef0123456789abcdef" / "inner")

    store._discard(root)
    store._discard(tmp_path)
    store._discard(outside)
    store._discard(root / ".." / "outside")
    store._discard(nested)

    assert root.is_dir()
    assert (outside / "keep.txt").is_file()
    assert (nested / "keep.txt").is_file()

    store._discard(nested.parent)
    assert not nested.parent.exists()
    assert root.is_dir()


@pytest.mark.georef
def test_expired_entry_discard_stays_within_the_root(tmp_path: Path) -> None:
    root = tmp_path / "store"
    store = ConversionStore(root=root, ttl_seconds=-1, max_entries=3)
    sibling = _plant_expired_entry(tmp_path / "sibling")
    cached = store.put(parse_ai(_build_minimal_ai_pdf(), "sample.ai"))

    with pytest.raises(ConversionExpiredError):
        store.get(cached.conversion_id)

    assert not cached.directory.exists()
    assert root.is_dir()
    assert (sibling / "keep.txt").is_file()
