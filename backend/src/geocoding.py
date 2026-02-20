"""Geocoding helpers used by wizard address assist features."""

from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Protocol

import httpx


class GeocodingError(Exception):
    """Raised when a geocoding request fails in a user-facing way."""

    def __init__(self, detail: str, *, code: str, status_code: int) -> None:
        self.detail = detail
        self.code = code
        self.status_code = status_code
        super().__init__(detail)


@dataclass(slots=True)
class GeocodeAddressParts:
    address: str | None = None
    unit: str | None = None
    locality: str | None = None
    province: str | None = None
    country: str | None = None
    postal_code: str | None = None
    postal_code_ext: str | None = None
    postal_code_vanity: str | None = None


@dataclass(slots=True)
class GeocodeMatch:
    display_name: str
    latitude: float
    longitude: float
    source: str
    address: GeocodeAddressParts


class GeocoderClient(Protocol):
    """Geocoding contract shared by real and test implementations."""

    def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
        raise NotImplementedError

    def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
        raise NotImplementedError


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _first_present(payload: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        value = _clean_text(payload.get(key))
        if value:
            return value
    return None


def _normalize_address_parts(payload: dict[str, Any]) -> GeocodeAddressParts:
    road = _first_present(payload, ["road", "pedestrian", "footway", "street", "residential"])
    house_number = _first_present(payload, ["house_number"])
    line = None
    if house_number and road:
        line = f"{house_number} {road}"
    elif road:
        line = road
    else:
        line = _first_present(payload, ["house", "building", "attraction"])

    locality = _first_present(
        payload,
        ["city", "town", "village", "municipality", "borough", "city_district", "suburb", "hamlet", "county"],
    )
    province = _first_present(payload, ["state", "province", "region", "state_district"])

    country_code = _clean_text(payload.get("country_code"))
    country_name = _clean_text(payload.get("country"))
    if country_code:
        country = country_code.upper()
    else:
        country = country_name

    return GeocodeAddressParts(
        address=line,
        locality=locality,
        province=province,
        country=country,
        postal_code=_first_present(payload, ["postcode"]),
        postal_code_ext=None,
        postal_code_vanity=None,
    )


class NominatimGeocoder:
    """Nominatim-backed geocoder with tiny in-memory response caching."""

    def __init__(
        self,
        *,
        base_url: str = "https://nominatim.openstreetmap.org",
        user_agent: str = "shp2imdf-converter/1.0",
        timeout_seconds: float = 8.0,
        cache_seconds: int = 900,
        max_cache_entries: int = 512,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent.strip() or "shp2imdf-converter/1.0"
        self.timeout_seconds = max(timeout_seconds, 1.0)
        self.cache_seconds = max(cache_seconds, 0)
        self.max_cache_entries = max(max_cache_entries, 0)
        self._cache: dict[str, tuple[float, Any]] = {}

    def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
        normalized_query = query.strip()
        if not normalized_query:
            return []

        payload = self._request_json(
            path="/search",
            params={
                "q": normalized_query,
                "format": "jsonv2",
                "addressdetails": 1,
                "limit": min(max(limit, 1), 10),
            },
            language=language,
        )
        if not isinstance(payload, list):
            return []

        matches: list[GeocodeMatch] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            parsed = self._parse_match(item)
            if parsed is None:
                continue
            matches.append(parsed)
        return matches

    def reverse(self, latitude: float, longitude: float, language: str) -> GeocodeMatch | None:
        payload = self._request_json(
            path="/reverse",
            params={
                "lat": latitude,
                "lon": longitude,
                "format": "jsonv2",
                "addressdetails": 1,
            },
            language=language,
        )
        if not isinstance(payload, dict):
            return None
        if "error" in payload:
            return None
        return self._parse_match(payload)

    def _request_json(self, path: str, params: dict[str, Any], language: str) -> Any:
        normalized_language = language.strip() or "en"
        cache_key = self._cache_key(path=path, params=params, language=normalized_language)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached

        try:
            response = httpx.get(
                f"{self.base_url}{path}",
                params=params,
                timeout=self.timeout_seconds,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept-Language": normalized_language,
                },
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException as exc:
            raise GeocodingError(
                "Geocoding request timed out.",
                code="GEOCODER_TIMEOUT",
                status_code=504,
            ) from exc
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            if status_code == 429:
                raise GeocodingError(
                    "Geocoding provider rate limit reached.",
                    code="GEOCODER_RATE_LIMIT",
                    status_code=503,
                ) from exc
            raise GeocodingError(
                f"Geocoding provider returned HTTP {status_code or 'error'}.",
                code="GEOCODER_UPSTREAM_ERROR",
                status_code=502,
            ) from exc
        except httpx.RequestError as exc:
            raise GeocodingError(
                "Geocoding service is unavailable.",
                code="GEOCODER_UNAVAILABLE",
                status_code=503,
            ) from exc
        except ValueError as exc:
            raise GeocodingError(
                "Geocoding provider returned invalid JSON.",
                code="GEOCODER_INVALID_RESPONSE",
                status_code=502,
            ) from exc

        self._cache_set(cache_key, payload)
        return payload

    def _parse_match(self, payload: dict[str, Any]) -> GeocodeMatch | None:
        try:
            latitude = float(payload.get("lat"))
            longitude = float(payload.get("lon"))
        except (TypeError, ValueError):
            return None

        display_name = _clean_text(payload.get("display_name")) or f"{latitude:.6f}, {longitude:.6f}"
        raw_address = payload.get("address")
        address = _normalize_address_parts(raw_address if isinstance(raw_address, dict) else {})
        return GeocodeMatch(
            display_name=display_name,
            latitude=latitude,
            longitude=longitude,
            source="nominatim",
            address=address,
        )

    def _cache_key(self, *, path: str, params: dict[str, Any], language: str) -> str:
        return json.dumps(
            {
                "path": path,
                "params": params,
                "language": language,
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def _cache_get(self, key: str) -> Any | None:
        if self.cache_seconds <= 0:
            return None
        entry = self._cache.get(key)
        if entry is None:
            return None
        expires_at, payload = entry
        if time.time() > expires_at:
            self._cache.pop(key, None)
            return None
        return payload

    def _cache_set(self, key: str, payload: Any) -> None:
        if self.cache_seconds <= 0 or self.max_cache_entries <= 0:
            return
        if key in self._cache:
            self._cache[key] = (time.time() + self.cache_seconds, payload)
            return

        if len(self._cache) >= self.max_cache_entries:
            now = time.time()
            expired = [cached_key for cached_key, (expires_at, _) in self._cache.items() if now > expires_at]
            for expired_key in expired:
                self._cache.pop(expired_key, None)

        if len(self._cache) >= self.max_cache_entries and self._cache:
            oldest_key = min(self._cache.items(), key=lambda item: item[1][0])[0]
            self._cache.pop(oldest_key, None)

        self._cache[key] = (time.time() + self.cache_seconds, payload)


def build_geocoder(
    *,
    provider: str,
    base_url: str,
    user_agent: str,
    timeout_seconds: float,
    cache_seconds: int,
    max_cache_entries: int,
) -> GeocoderClient | None:
    normalized = provider.strip().lower()
    if normalized in {"", "none", "disabled", "off"}:
        return None
    if normalized == "nominatim":
        return NominatimGeocoder(
            base_url=base_url,
            user_agent=user_agent,
            timeout_seconds=timeout_seconds,
            cache_seconds=cache_seconds,
            max_cache_entries=max_cache_entries,
        )
    raise ValueError(f"Unsupported geocoder provider: {provider}")
