"""Mapper tests for Phase 3."""

from __future__ import annotations

import pytest

from backend.src.mapper import (
    build_unit_code_preview,
    detect_candidate_columns,
    normalize_company_mappings_payload,
    normalize_unit_category_overrides,
    resolve_unit_category,
    wrap_labels,
)
from backend.src.schemas import ImportedFile


@pytest.mark.phase3
def test_resolve_unit_category_prefers_company_mapping() -> None:
    valid = {"unspecified", "retail", "office"}
    category, unresolved = resolve_unit_category(
        raw_code="SHOP",
        company_mappings={"SHOP": "retail"},
        valid_categories=valid,
        default_category="unspecified",
    )
    assert category == "retail"
    assert unresolved is False


@pytest.mark.phase3
def test_resolve_unit_category_supports_direct_imdf_value() -> None:
    valid = {"unspecified", "retail", "office"}
    category, unresolved = resolve_unit_category(
        raw_code="office",
        company_mappings={},
        valid_categories=valid,
        default_category="unspecified",
    )
    assert category == "office"
    assert unresolved is False


@pytest.mark.phase3
def test_resolve_unit_category_maps_retail_store_alias() -> None:
    valid = {"unspecified", "retail", "office"}
    category, unresolved = resolve_unit_category(
        raw_code="retail store",
        company_mappings={},
        valid_categories=valid,
        default_category="unspecified",
    )
    assert category == "retail"
    assert unresolved is False


@pytest.mark.phase3
def test_detect_candidate_columns_filters_by_feature_type() -> None:
    files = [
        ImportedFile(
            stem="A",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["NAME", "COMPANY_CO"],
            detected_type="unit",
        ),
        ImportedFile(
            stem="B",
            geometry_type="LineString",
            feature_count=1,
            attribute_columns=["TYPE"],
            detected_type="opening",
        ),
    ]
    assert detect_candidate_columns(files, feature_type="unit") == ["COMPANY_CO", "NAME"]


@pytest.mark.phase3
def test_normalize_company_mapping_payload_applies_defaults() -> None:
    valid = {"unspecified", "retail", "office"}
    mappings, default = normalize_company_mappings_payload(
        payload={
            "default_category": "office",
            "mappings": {
                "SHOP": "retail",
                "UNK": "invalid-category",
            },
        },
        valid_categories=valid,
        fallback_default="unspecified",
    )
    assert default == "office"
    assert mappings["SHOP"] == "retail"
    assert mappings["UNK"] == "office"


@pytest.mark.phase3
def test_normalize_company_mapping_payload_maps_retail_store_alias() -> None:
    valid = {"unspecified", "retail", "office"}
    mappings, default = normalize_company_mappings_payload(
        payload={
            "default_category": "unspecified",
            "mappings": {
                "SHOP": "retail-store",
            },
        },
        valid_categories=valid,
        fallback_default="unspecified",
    )
    assert default == "unspecified"
    assert mappings["SHOP"] == "retail"


@pytest.mark.phase3
def test_build_unit_code_preview_and_labels() -> None:
    files = [
        ImportedFile(
            stem="UNIT_A",
            geometry_type="Polygon",
            feature_count=3,
            attribute_columns=["COMPANY_CO", "NAME"],
            detected_type="unit",
        )
    ]
    feature_collection = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "1",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": []},
                "properties": {"source_file": "UNIT_A", "metadata": {"COMPANY_CO": "SHOP"}},
            },
            {
                "type": "Feature",
                "id": "2",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": []},
                "properties": {"source_file": "UNIT_A", "metadata": {"COMPANY_CO": "office"}},
            },
            {
                "type": "Feature",
                "id": "3",
                "feature_type": "unit",
                "geometry": {"type": "Polygon", "coordinates": []},
                "properties": {"source_file": "UNIT_A", "metadata": {"COMPANY_CO": "???"}},
            },
        ],
    }
    preview = build_unit_code_preview(
        feature_collection=feature_collection,
        files=files,
        code_column="COMPANY_CO",
        company_mappings={"SHOP": "retail"},
        valid_categories={"unspecified", "retail", "office"},
        default_category="unspecified",
    )
    by_code = {item.code: item for item in preview}
    assert by_code["SHOP"].resolved_category == "retail"
    assert by_code["office"].resolved_category == "office"
    assert by_code["???"].resolved_category == "unspecified"
    assert by_code["???"].unresolved is True
    assert wrap_labels("Main Hall", language="en") == {"en": "Main Hall"}
    assert wrap_labels("", language="en") is None


@pytest.mark.phase3
def test_resolve_unit_category_requires_category_to_exist_in_config() -> None:
    valid = {"unspecified", "retail", "office"}
    category, unresolved = resolve_unit_category(
        raw_code="restroom.unisex.wheelchair",
        company_mappings={},
        valid_categories=valid,
        default_category="unspecified",
    )
    assert category == "unspecified"
    assert unresolved is True


@pytest.mark.phase3
def test_normalize_company_mapping_rejects_unknown_categories() -> None:
    valid = {"unspecified", "retail", "office"}
    mappings, default = normalize_company_mappings_payload(
        payload={
            "default_category": "office",
            "mappings": {
                "RESTROOM": "restroom.unisex.wheelchair",
                "BAD": "invalid-category",
            },
        },
        valid_categories=valid,
        fallback_default="unspecified",
    )
    assert default == "office"
    assert mappings["RESTROOM"] == "office"
    assert mappings["BAD"] == "office"


@pytest.mark.phase3
def test_resolve_unit_category_accepts_configured_dotted_category() -> None:
    valid = {"unspecified", "retail", "restroom.unisex.wheelchair"}
    category, unresolved = resolve_unit_category(
        raw_code="restroom.unisex.wheelchair",
        company_mappings={},
        valid_categories=valid,
        default_category="unspecified",
    )
    assert category == "restroom.unisex.wheelchair"
    assert unresolved is False


@pytest.mark.phase3
def test_normalize_unit_category_overrides_filters_invalid_values() -> None:
    normalized = normalize_unit_category_overrides(
        {
            "shop": "retail",
            "  ": "office",
            "(empty)": "office",
            "bad": "not-a-real-category",
        },
        {"unspecified", "retail", "office"},
    )
    assert normalized == {"SHOP": "retail"}
