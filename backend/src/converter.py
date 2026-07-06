"""Convert review feature collections into IMDF export files."""

from __future__ import annotations

import copy
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from backend.src.schemas import SessionRecord


CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"

# ODC/GSI sessions keep raw spec codes (e.g. "A001", "B001") in category fields;
# they must be translated back to IMDF categories before IMDF export.
_SPEC_CODE_PATTERN = re.compile(r"^[A-Za-z]\d{3}$")
_CATEGORY_CODE_FILES = {"venue": "a-codes.json", "unit": "b-codes.json"}


IMDF_TYPE_ORDER = [
    "address",
    "venue",
    "building",
    "footprint",
    "level",
    "unit",
    "opening",
    "fixture",
    "section",
    "anchor",
    "kiosk",
    "amenity",
    "occupant",
    "geofence",
    "relationship",
    "detail",
    "facility",
]
REQUIRED_IMDF_TYPES = {"address", "venue", "building", "footprint", "level", "unit"}
REVIEW_ONLY_PROPERTY_KEYS = {
    "status",
    "issues",
    "metadata",
    "source_file",
    "source_row_index",
    "source_part_index",
    "source_feature_ref",
}


@lru_cache(maxsize=None)
def _category_code_map(filename: str) -> tuple[dict[str, str], str]:
    path = CONFIG_DIR / filename
    default = "unspecified"
    if not path.exists():
        return {}, default
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}, default
    default = str(payload.get("default_category") or default).strip().lower() or "unspecified"
    mappings = payload.get("mappings")
    if not isinstance(mappings, dict):
        return {}, default
    return (
        {
            str(code).strip().upper(): str(category).strip().lower()
            for code, category in mappings.items()
            if str(code).strip() and str(category).strip()
        },
        default,
    )


def _translate_spec_code_category(feature_type: Any, properties: dict[str, Any]) -> None:
    code_file = _CATEGORY_CODE_FILES.get(feature_type) if isinstance(feature_type, str) else None
    if code_file is None:
        return
    category = properties.get("category")
    if not isinstance(category, str) or not _SPEC_CODE_PATTERN.fullmatch(category.strip()):
        return
    mappings, default = _category_code_map(code_file)
    properties["category"] = mappings.get(category.strip().upper(), default)


def _clean_export_feature(feature: dict[str, Any]) -> dict[str, Any]:
    cleaned = copy.deepcopy(feature)
    properties = cleaned.get("properties")
    if isinstance(properties, dict):
        cleaned["properties"] = {k: v for k, v in properties.items() if k not in REVIEW_ONLY_PROPERTY_KEYS}
        _translate_spec_code_category(cleaned.get("feature_type"), cleaned["properties"])
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
