"""Heavy upload handlers must not freeze the server for everyone else."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest

from backend.src.schemas import CleanupSummary, ImportedFile

_SLOW_SECONDS = 1.5
_PDF = ("a.pdf", b"%PDF-1.4 stub", "application/pdf")


def _stall(*_args, **_kwargs):
    time.sleep(_SLOW_SECONDS)
    raise ValueError("stalled on purpose")


class _SlowGeocoder:
    def search(self, *_args, **_kwargs):
        return _stall()


def _session_id(test_client) -> str:
    return test_client.app.state.session_manager.create_session(
        files=[ImportedFile(stem="seed", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
    ).session_id


_CASES = {
    "import": ("backend.routers.import_router.import_file_blobs", "post", "/api/import", {"files": [("files", ("a.shp", b"x", "application/octet-stream"))]}),
    "import_imdf_shapefiles": ("backend.routers.import_router.import_imdf_shapefile_blobs", "post", "/api/import/imdf-shapefiles", {"files": [("files", ("a.shp", b"x", "application/octet-stream"))]}),
    "import_imdf": ("backend.routers.import_router.read_imdf_zip", "post", "/api/import/imdf", {"files": {"file": ("a.zip", b"x", "application/zip")}}),
    "convert_illustrator": ("backend.routers.import_router.convert_ai_to_geopackage_bundle", "post", "/api/convert/illustrator", {"files": {"file": _PDF}}),
    "preview_illustrator": ("backend.routers.import_router.parse_ai", "post", "/api/convert/illustrator/preview", {"files": {"file": _PDF}}),
    "reference_layers": ("backend.routers.import_router.read_reference_layers", "post", "/api/reference-layers", {"files": [("files", ("a.shp", b"x", "application/octet-stream"))]}),
    "geocode": (None, "get", "/api/geocode?query=tokyo", {}),
    "company_mappings": ("backend.routers.wizard_router.normalize_company_mappings_payload", "post", "/api/session/{session_id}/config/company-mappings", {"files": {"file": ("m.json", b"{}", "application/json")}}),
}


@pytest.mark.phase6
@pytest.mark.parametrize("case", sorted(_CASES))
def test_health_answers_while_heavy_handler_runs(test_client, monkeypatch, case: str) -> None:
    target, method, url, kwargs = _CASES[case]
    if target is None:
        monkeypatch.setattr(test_client.app.state, "geocoder", _SlowGeocoder())
    else:
        monkeypatch.setattr(target, _stall)
    url = url.format(session_id=_session_id(test_client) if "{session_id}" in url else "")

    started = threading.Event()

    def heavy():
        started.set()
        return getattr(test_client, method)(url, **kwargs)

    def health():
        assert started.wait(timeout=5.0)
        time.sleep(0.3)
        began = time.perf_counter()
        response = test_client.get("/api/health")
        return response, time.perf_counter() - began

    with ThreadPoolExecutor(max_workers=2) as pool:
        heavy_future = pool.submit(heavy)
        health_future = pool.submit(health)
        health_response, elapsed = health_future.result()
        heavy_response = heavy_future.result()

    assert heavy_response.status_code == 400, heavy_response.text
    assert health_response.status_code == 200
    assert elapsed < _SLOW_SECONDS / 2
