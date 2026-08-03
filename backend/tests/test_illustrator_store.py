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
def test_oldest_entries_are_evicted_beyond_the_cap(store: ConversionStore) -> None:
    payload = _build_minimal_ai_pdf()
    first = store.put(parse_ai(payload, "one.ai"))
    for name in ("two.ai", "three.ai", "four.ai"):
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
