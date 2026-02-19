"""Convert review feature collections into IMDF export files."""

from __future__ import annotations

import copy
from typing import Any

from backend.src.schemas import SessionRecord


IMDF_TYPE_ORDER = [
    "address",
    "venue",
    "building",
    "footprint",
    "level",
    "unit",
    "opening",
    "fixture",
    "detail",
]
REQUIRED_IMDF_TYPES = {"address", "venue", "building", "footprint", "level", "unit"}
REVIEW_ONLY_PROPERTY_KEYS = {"status", "issues", "metadata", "source_file"}


def _clean_export_feature(feature: dict[str, Any]) -> dict[str, Any]:
    cleaned = copy.deepcopy(feature)
    properties = cleaned.get("properties")
    if isinstance(properties, dict):
        cleaned["properties"] = {k: v for k, v in properties.items() if k not in REVIEW_ONLY_PROPERTY_KEYS}
    return cleaned


def build_imdf_geojson_files(feature_collection: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = feature_collection.get("features", [])
    if not isinstance(rows, list):
        rows = []

    grouped: dict[str, list[dict[str, Any]]] = {feature_type: [] for feature_type in IMDF_TYPE_ORDER}
    for item in rows:
        if not isinstance(item, dict):
            continue
        feature_type = item.get("feature_type")
        if not isinstance(feature_type, str):
            continue
        if feature_type not in grouped:
            continue
        grouped[feature_type].append(_clean_export_feature(item))

    payloads: dict[str, dict[str, Any]] = {}
    for feature_type in IMDF_TYPE_ORDER:
        features = grouped[feature_type]
        if feature_type not in REQUIRED_IMDF_TYPES and not features:
            continue
        payloads[f"{feature_type}.geojson"] = {
            "type": "FeatureCollection",
            "features": features,
        }
    return payloads


def build_session_imdf_geojson_files(session: SessionRecord) -> dict[str, dict[str, Any]]:
    return build_imdf_geojson_files(session.feature_collection)
