"""Mapping helpers for Phase 3 wizard configuration."""

from __future__ import annotations

import difflib
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Any

from backend.src.schemas import ImportedFile, UnitCodePreviewRow


CATEGORY_ALIASES = {
    "retailstore": "retail",
}

RESTRICTION_CATEGORIES_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "categories" / "restriction_categories.json"
)
# Source data spells the IMDF `restriction` enum by hand and gets it wrong: the
# 池袋 dataset ships "enpliyeesonly" on 1F while its own B1 file says
# "employeesonly". A value that close to a legal one is a typo, not a different
# meaning, so it is repaired rather than carried into unit.json and the ODC
# Space layer. 0.8 sits in a wide empty band: typos of these two values score
# >= 0.84 against the one they meant, while genuinely different words
# ("public", "staffonly", "nonpublic", "open") score <= 0.46.
_RESTRICTION_TYPO_RATIO = 0.8


def _normalize_category_alias(value: str) -> str:
    normalized = value.strip().lower()
    if not normalized:
        return normalized

    compact = normalized.replace(" ", "").replace("-", "").replace("_", "")
    aliased = CATEGORY_ALIASES.get(compact)
    return aliased if aliased else normalized


@lru_cache(maxsize=1)
def load_restriction_categories() -> tuple[str, ...]:
    """The legal IMDF ``restriction`` values, in config order."""
    try:
        payload = json.loads(RESTRICTION_CATEGORIES_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ()
    categories = payload.get("categories")
    if not isinstance(categories, list):
        return ()
    return tuple(str(item).strip().lower() for item in categories if str(item).strip())


# The ODC/GSI shapefile spec writes `restricted` as a code, not a word: 1 is
# staff-only, 2 is "no restriction" — which IMDF spells as no value at all
# rather than a member of the enum. Left untranslated these travelled into
# unit.geojson verbatim and Apple rejected every one of them; 高輪ゲートウェイ
# alone carried 157.
RESTRICTION_CODES: dict[str, str | None] = {"1": "employeesonly", "2": None}
RESTRICTION_CODE_BY_VALUE: dict[str | None, str] = {value: code for code, value in RESTRICTION_CODES.items()}


def normalize_restriction(value: Any) -> str | None:
    """Canonical IMDF ``restriction`` for ``value``, or the trimmed text as given.

    Exact members pass through; formatting differences ("Employees Only",
    "employees_only") and near misses of one member ("enpliyeesonly") resolve to
    that member, as do the ODC spec's numeric codes. A value close to nothing
    legal is left alone rather than guessed at or dropped - it may carry meaning
    this enum cannot express, and it is the source data that has to be corrected.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    # Before the fuzzy match: "1" and "2" are nowhere near any member, and
    # guessing at them is exactly what the fallback is meant to avoid.
    if text in RESTRICTION_CODES:
        return RESTRICTION_CODES[text]
    legal = load_restriction_categories()
    lowered = text.lower()
    if lowered in legal:
        return lowered
    compact = re.sub(r"[^a-z0-9]+", "", lowered)
    if compact in legal:
        return compact
    near = difflib.get_close_matches(compact, legal, n=1, cutoff=_RESTRICTION_TYPO_RATIO)
    return near[0] if near else text



def denormalize_restriction(value: Any) -> str | None:
    """The ODC spec's code for an IMDF ``restriction``.

    The inverse of the code table above, for writing the Space layer back out.
    Without it the round trip loses: a source "1" is read as ``employeesonly``
    and would be written back as that word, which the spec has no room for.

    A value with no code — ``restricted``, or anything the source invented — is
    passed through unchanged rather than guessed at, the same way the import
    leaves what it cannot resolve alone.
    """
    if value is None:
        return RESTRICTION_CODE_BY_VALUE[None]
    text = str(value).strip()
    if not text:
        return RESTRICTION_CODE_BY_VALUE[None]
    return RESTRICTION_CODE_BY_VALUE.get(text.lower(), text)

def load_unit_categories(config_path: str | Path) -> tuple[set[str], str]:
    payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
    categories = {str(item).strip().lower() for item in payload.get("categories", []) if str(item).strip()}
    default_category = str(payload.get("default_category", "unspecified")).strip().lower() or "unspecified"
    if default_category not in categories:
        categories.add(default_category)
    return categories, default_category


def is_valid_category_value(value: str, valid_categories: set[str]) -> bool:
    normalized = value.strip().lower()
    return bool(normalized and normalized in valid_categories)


def normalize_company_mappings_payload(
    payload: dict[str, Any],
    valid_categories: set[str],
    fallback_default: str,
) -> tuple[dict[str, str], str]:
    raw_default = str(payload.get("default_category", fallback_default)).strip().lower()
    default_category = raw_default if is_valid_category_value(raw_default, valid_categories) else fallback_default

    mappings: dict[str, str] = {}
    raw_mappings = payload.get("mappings", {})
    if isinstance(raw_mappings, dict):
        for raw_code, raw_category in raw_mappings.items():
            code = str(raw_code).strip().upper()
            if not code:
                continue
            category = _normalize_category_alias(str(raw_category))
            if not is_valid_category_value(category, valid_categories):
                category = default_category
            mappings[code] = category
    return mappings, default_category


def normalize_unit_category_overrides(
    overrides: dict[str, Any] | None,
    valid_categories: set[str],
) -> dict[str, str]:
    normalized: dict[str, str] = {}
    if not isinstance(overrides, dict):
        return normalized

    for raw_code, raw_category in overrides.items():
        code = str(raw_code).strip()
        if not code or code == "(empty)":
            continue
        category = _normalize_category_alias(str(raw_category))
        if category not in valid_categories:
            continue
        normalized[code.upper()] = category
    return normalized


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

    normalized = _normalize_category_alias(code_text)
    if is_valid_category_value(normalized, valid_categories):
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
