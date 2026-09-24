"""Concurrent requests against one session must not lose each other's writes."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

from backend.routers import export_router
from backend.src.schemas import CleanupSummary, ImportedFile


def _seed_session(test_client):
    feature = {
        "type": "Feature",
        "id": "unit-1",
        "feature_type": "unit",
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]},
        "properties": {"category": "room", "name": {"en": "Before"}},
    }
    return test_client.app.state.session_manager.create_session(
        files=[ImportedFile(stem="seed", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": [feature]},
    )


@pytest.mark.phase5
def test_patch_during_validate_is_not_lost(test_client, monkeypatch) -> None:
    session = _seed_session(test_client)
    annotating = threading.Event()
    patched = threading.Event()
    real_annotate = export_router.annotate_feature_collection_with_validation

    def slow_annotate(feature_collection, validation):
        result = real_annotate(feature_collection, validation)
        annotating.set()
        patched.wait(timeout=1.0)
        return result

    monkeypatch.setattr(export_router, "annotate_feature_collection_with_validation", slow_annotate)

    def patch_after_validate_starts():
        assert annotating.wait(timeout=5.0)
        response = test_client.patch(
            f"/api/session/{session.session_id}/features/unit-1",
            json={"properties": {"name": {"en": "After"}}},
        )
        patched.set()
        return response

    with ThreadPoolExecutor(max_workers=2) as pool:
        validate_future = pool.submit(test_client.post, f"/api/session/{session.session_id}/validate")
        patch_future = pool.submit(patch_after_validate_starts)
        assert validate_future.result().status_code == 200
        assert patch_future.result().status_code == 200

    features = test_client.get(f"/api/session/{session.session_id}/features").json()["features"]
    assert features[0]["properties"]["name"] == {"en": "After"}
