"""ISO 3166-1 / 3166-2 helpers backed by pycountry.

IMDF's ``address`` feature requires ``country`` to be an ISO 3166-1 alpha-2 code
(e.g. ``"JP"``) and ``province`` to be a full ISO 3166-2 subdivision code
(e.g. ``"JP-01"``, i.e. ``<country>-<subdivision>``). These helpers back both the
Review-step validation and the province picker reference endpoint so there is a
single source of truth for valid codes.
"""

from __future__ import annotations

import pycountry


def normalize_country(country: str | None) -> str | None:
    """Return an upper-cased, trimmed alpha-2 country code, or ``None``."""
    if not country:
        return None
    return country.strip().upper() or None


def normalize_subdivision(code: str | None) -> str | None:
    """Return an upper-cased, trimmed ISO 3166-2 code, or ``None``."""
    if not code:
        return None
    return code.strip().upper() or None


def is_valid_country(country: str | None) -> bool:
    code = normalize_country(country)
    if not code:
        return False
    return pycountry.countries.get(alpha_2=code) is not None


def is_valid_subdivision(code: str | None) -> bool:
    normalized = normalize_subdivision(code)
    if not normalized:
        return False
    return pycountry.subdivisions.get(code=normalized) is not None


def subdivisions_for_country(country: str | None) -> list[dict[str, str]]:
    """Return ``[{"code", "name"}, ...]`` for a country, sorted by code.

    Empty when the country is unknown or has no listed subdivisions.
    """
    code = normalize_country(country)
    if not code:
        return []
    subdivisions = pycountry.subdivisions.get(country_code=code) or []
    items = [{"code": sub.code, "name": sub.name} for sub in subdivisions]
    items.sort(key=lambda item: item["code"])
    return items
