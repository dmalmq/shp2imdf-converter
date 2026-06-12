"""Static reference data endpoints (not session-scoped)."""

from __future__ import annotations

from fastapi import APIRouter

from backend.src.iso_subdivisions import normalize_country, subdivisions_for_country
from backend.src.schemas import IsoSubdivision, IsoSubdivisionsResponse


router = APIRouter(prefix="/api", tags=["reference"])


@router.get("/reference/iso-subdivisions", response_model=IsoSubdivisionsResponse)
def get_iso_subdivisions(country: str) -> IsoSubdivisionsResponse:
    """Return ISO 3166-2 subdivisions for an ISO 3166-1 alpha-2 country code.

    Powers the wizard province picker so users select a valid code (e.g.
    ``JP-01``) instead of free-typing a prefecture name.
    """
    normalized = normalize_country(country) or ""
    return IsoSubdivisionsResponse(
        country=normalized,
        subdivisions=[IsoSubdivision(**item) for item in subdivisions_for_country(country)],
    )
