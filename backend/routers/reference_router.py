"""Static reference data endpoints (not session-scoped)."""

from __future__ import annotations

from fastapi import APIRouter

from backend.src.feature_types import feature_type_catalog
from backend.src.iso_subdivisions import normalize_country, subdivisions_for_country
from backend.src.schemas import (
    FeatureTypeCatalogResponse,
    FeatureTypeOption,
    IsoSubdivision,
    IsoSubdivisionsResponse,
)


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


@router.get("/reference/feature-types", response_model=FeatureTypeCatalogResponse)
def get_feature_types() -> FeatureTypeCatalogResponse:
    """Return every IMDF feature type with its geometry family and categories.

    Powers the review editor's type picker: the client filters the list by the
    selected feature's geometry so it can only offer a re-type the backend will
    accept, and drives the category select from the target type's catalog.
    """
    return FeatureTypeCatalogResponse(
        feature_types=[FeatureTypeOption(**item) for item in feature_type_catalog()]
    )
