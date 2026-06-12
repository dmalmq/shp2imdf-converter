"""Geocoding client tests."""

from __future__ import annotations

import httpx
import pytest

from backend.src.geocoding import GeocodingError, NominatimGeocoder, _normalize_address_parts


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


@pytest.mark.phase3
def test_normalize_address_uses_iso_3166_2_code_for_province() -> None:
    parts = _normalize_address_parts(
        {
            "state": "Hokkaidô",
            "ISO3166-2-lvl4": "JP-01",
            "country_code": "jp",
        }
    )
    assert parts.province == "JP-01"
    assert parts.country == "JP"


@pytest.mark.phase3
def test_normalize_address_prefers_lowest_admin_level_code() -> None:
    parts = _normalize_address_parts(
        {
            "ISO3166-2-lvl6": "GB-XYZ",
            "ISO3166-2-lvl4": "GB-ENG",
            "country_code": "gb",
        }
    )
    assert parts.province == "GB-ENG"


@pytest.mark.phase3
def test_normalize_address_falls_back_to_name_without_iso_code() -> None:
    parts = _normalize_address_parts({"state": "Hokkaidô", "country_code": "jp"})
    assert parts.province == "Hokkaidô"


@pytest.mark.phase3
def test_nominatim_cache_respects_max_entries() -> None:
    geocoder = NominatimGeocoder(cache_seconds=60, max_cache_entries=2)

    geocoder._cache_set("a", {"value": 1})
    geocoder._cache_set("b", {"value": 2})
    geocoder._cache_set("c", {"value": 3})

    assert len(geocoder._cache) == 2
    assert "a" not in geocoder._cache
    assert "c" in geocoder._cache
