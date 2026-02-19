"""Mapping helpers for Phase 3 wizard configuration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.src.schemas import ImportedFile, UnitCodePreviewRow


def load_unit_categories(config_path: str | Path) -> tuple[set[str], str]:
    payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
    categories = {str(item).strip().lower() for item in payload.get("categories", []) if str(item).strip()}
    default_category = str(payload.get("default_category", "unspecified")).strip().lower() or "unspecified"
    if default_category not in categories:
        categories.add(default_category)
    return categories, default_category


def normalize_company_mappings_payload(
    payload: dict[str, Any],
    valid_categories: set[str],
    fallback_default: str,
) -> tuple[dict[str, str], str]:
    raw_default = str(payload.get("default_category", fallback_default)).strip().lower()
    default_category = raw_default if raw_default in valid_categories else fallback_default

    mappings: dict[str, str] = {}
    raw_mappings = payload.get("mappings", {})
    if isinstance(raw_mappings, dict):
        for raw_code, raw_category in raw_mappings.items():
            code = str(raw_code).strip().upper()
            if not code:
                continue
            category = str(raw_category).strip().lower()
            if category not in valid_categories:
                category = default_category
            mappings[code] = category
    return mappings, default_category


def wrap_labels(value: Any, language: str = "en") -> dict[str, str] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        normalized = {str(key): str(item) for key, item in value.items() if str(item).strip()}
        return normalized or None
    text = str(value).strip()
    if not text:
        return None
    tag = language.strip() or "en"
    return {tag: text}


def detect_candidate_columns(files: list[ImportedFile], feature_type: str) -> list[str]:
    columns: set[str] = set()
    for file in files:
        if (file.detected_type or "").lower() != feature_type.lower():
            continue
        columns.update(file.attribute_columns)
    return sorted(columns)


def resolve_unit_category(
    raw_code: Any,
    company_mappings: dict[str, str],
    valid_categories: set[str],
    default_category: str,
) -> tuple[str, bool]:
    if raw_code is None:
        return default_category, True

    code_text = str(raw_code).strip()
    if not code_text:
        return default_category, True

    mapped = company_mappings.get(code_text.upper())
    if mapped:
        return mapped, False

    normalized = code_text.lower()
    if normalized in valid_categories:
        return normalized, False

    return default_category, True


def build_unit_code_preview(
    feature_collection: dict[str, Any],
    files: list[ImportedFile],
    code_column: str | None,
    company_mappings: dict[str, str],
    valid_categories: set[str],
    default_category: str,
) -> list[UnitCodePreviewRow]:
    if not code_column:
        return []

    unit_stems = {file.stem for file in files if (file.detected_type or "").lower() == "unit"}
    if not unit_stems:
        return []

    aggregated: dict[str, UnitCodePreviewRow] = {}
    for feature in feature_collection.get("features", []):
        properties = feature.get("properties") or {}
        source_file = properties.get("source_file")
        if source_file not in unit_stems:
            continue

        metadata = properties.get("metadata") or {}
        raw_code = metadata.get(code_column)
        code_label = "(empty)" if raw_code is None or str(raw_code).strip() == "" else str(raw_code).strip()
        resolved, unresolved = resolve_unit_category(
            raw_code=raw_code,
            company_mappings=company_mappings,
            valid_categories=valid_categories,
            default_category=default_category,
        )
        existing = aggregated.get(code_label)
        if existing:
            existing.count += 1
            existing.unresolved = existing.unresolved or unresolved
            continue
        aggregated[code_label] = UnitCodePreviewRow(
            code=code_label,
            count=1,
            resolved_category=resolved,
            unresolved=unresolved,
        )

    return sorted(aggregated.values(), key=lambda item: item.code)

