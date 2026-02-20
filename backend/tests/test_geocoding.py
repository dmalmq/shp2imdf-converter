"""Geocoding client tests."""

from __future__ import annotations

import httpx
import pytest

from backend.src.geocoding import GeocodingError, NominatimGeocoder


@pytest.mark.phase3
def test_nominatim_search_maps_timeout_to_geocoding_error(monkeypatch) -> None:
    def fake_get(*args, **kwargs):  # noqa: ANN002, ANN003
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr("backend.src.geocoding.httpx.get", fake_get)
    geocoder = NominatimGeocoder(base_url="https://example.test")

    with pytest.raises(GeocodingError) as exc_info:
        geocoder.search("Tokyo Station", language="en")
    assert exc_info.value.code == "GEOCODER_TIMEOUT"
    assert exc_info.value.status_code == 504


@pytest.mark.phase3
def test_nominatim_search_maps_rate_limit_to_service_unavailable(monkeypatch) -> None:
    def fake_get(*args, **kwargs):  # noqa: ANN002, ANN003
        request = httpx.Request("GET", "https://example.test/search")
        response = httpx.Response(status_code=429, request=request)
        raise httpx.HTTPStatusError("too many requests", request=request, response=response)

    monkeypatch.setattr("backend.src.geocoding.httpx.get", fake_get)
    geocoder = NominatimGeocoder(base_url="https://example.test")

    with pytest.raises(GeocodingError) as exc_info:
        geocoder.search("Tokyo Station", language="en")
    assert exc_info.value.code == "GEOCODER_RATE_LIMIT"
    assert exc_info.value.status_code == 503
