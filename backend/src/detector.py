"""Filename/geometry detection and session-learning helpers."""

from __future__ import annotations

from collections import defaultdict
import copy
import json
from pathlib import Path
import re

from backend.src.schemas import ImportedFile, LearningSuggestion


FEATURE_TYPE_VALUES = {
    "unit",
    "opening",
    "fixture",
    "detail",
    "level",
    "building",
    "venue",
    "amenity",
    "anchor",
    "geofence",
    "kiosk",
    "occupant",
    "relationship",
    "section",
    "facility",
}


def _is_level_token(token: str) -> bool:
    lowered = token.lower()
    if lowered.isdigit():
        return True
    if re.fullmatch(r"b\d+", lowered):
        return True
    if lowered in {"g", "gf", "gh"}:
        return True
    return False


def stem_suffix_token(stem: str) -> str | None:
    tokens = stem_tokens(stem)
    for token in reversed(tokens):
        if _is_level_token(token):
            continue
        return token
    return None


def load_keyword_map(config_path: str | Path) -> dict[str, set[str]]:
    payload = json.loads(Path(config_path).read_text(encoding="utf-8"))
    configured = payload.get("feature_type_keywords", {})
    mapped: dict[str, set[str]] = {}
    for feature_type, keywords in configured.items():
        mapped[feature_type] = {keyword.lower().strip() for keyword in keywords if keyword and keyword.strip()}
    return mapped


def merge_learned_keywords(
    base_keywords: dict[str, set[str]],
    learned_keywords: dict[str, str],
) -> dict[str, set[str]]:
    merged = copy.deepcopy(base_keywords)
    for keyword, feature_type in learned_keywords.items():
        if feature_type not in FEATURE_TYPE_VALUES:
            continue
        merged.setdefault(feature_type, set()).add(keyword.lower())
    return merged


def stem_tokens(stem: str) -> list[str]:
    return [token.lower() for token in re.findall(r"[a-zA-Z0-9]+", stem) if token]


def detect_feature_type(stem: str, geometry_type: str, keywords: dict[str, set[str]]) -> tuple[str | None, str]:
    lowered = stem.lower()
    suffix_token = stem_suffix_token(stem)

    # Legacy datasets often use "*_Drawing" stems for detail linework.
    if re.search(r"(^|[^a-z0-9])drawing$", lowered):
        return "detail", "green"

    best_match: tuple[str, int] | None = None
    for feature_type, values in keywords.items():
        for keyword in values:
            candidate = keyword.lower().strip()
            if not candidate:
                continue

            if candidate.startswith("suffix:"):
                expected_suffix = candidate[len("suffix:") :]
                if suffix_token == expected_suffix:
                    # Prefer explicit suffix rules over substring matches.
                    keyword_len = len(expected_suffix) + 1000
                    if best_match is None or keyword_len > best_match[1]:
                        best_match = (feature_type, keyword_len)
                continue

            if candidate in lowered:
                keyword_len = len(candidate)
                if best_match is None or keyword_len > best_match[1]:
                    best_match = (feature_type, keyword_len)

    if best_match:
        return best_match[0], "green"

    normalized_geom = geometry_type.lower()
    if "polygon" in normalized_geom:
        return "unit", "yellow"
    if "linestring" in normalized_geom:
        return "opening", "yellow"
    return None, "red"


def detect_level_ordinal(stem: str) -> int | None:
    normalized = stem.upper()

    # Basement: B<digits>(F?L?)? — e.g. B1, B2F, B4FL. Skip large numbers
    # (>200) which are likely years, not floors. Use lookarounds to resume
    # searching past skipped matches.
    for match in re.finditer(r"(?<![A-Z0-9])B(\d+)(FL?)?(?![A-Z0-9])", normalized):
        label = int(match.group(1))
        if label <= 200:
            return -label

    negative = re.search(r"(?<![A-Z0-9])-(\d+)(?![A-Z0-9])", normalized)
    if negative:
        return -int(negative.group(1))

    if re.search(r"(?<![A-Z0-9])(GF|GH|G)(?![A-Z0-9])", normalized):
        return 0

    if re.search(r"(?<![A-Z0-9])0(?![A-Z0-9])", normalized):
        return 0

    # Positive floor: <digits>(F?L?)? — e.g. 1F, 2F, 1FL, M2. The 1F=ground
    # convention subtracts 1 from the label. Skip large numbers (>200):
    # filenames that contain a year (e.g. "..._2024_1F_...") must not resolve
    # to ordinal 2023; lookarounds let us find the next smaller match instead.
    for match in re.finditer(r"(?<![A-Z0-9])(\d+)(FL?)?(?![A-Z0-9])", normalized):
        label = int(match.group(1))
        if label <= 200:
            return label - 1
    return None


def detect_files(
    files: list[ImportedFile],
    keywords: dict[str, set[str]],
    preserve_manual_levels: bool = True,
) -> list[ImportedFile]:
    detected: list[ImportedFile] = []
    for item in files:
        inferred_type, confidence = detect_feature_type(item.stem, item.geometry_type, keywords)
        inferred_level = detect_level_ordinal(item.stem)

        updated = item.model_copy(deep=True)
        updated.detected_type = inferred_type
        updated.confidence = confidence
        if not preserve_manual_levels or updated.detected_level is None:
            updated.detected_level = inferred_level
        detected.append(updated)
    return detected


def file_features_by_stem(feature_collection: dict) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for feature in feature_collection.get("features", []):
        stem = feature.get("properties", {}).get("source_file")
        if stem:
            grouped[stem].append(feature)
    return grouped


def sync_feature_types(feature_collection: dict, files: list[ImportedFile]) -> dict:
    stem_to_type = {item.stem: item.detected_type or "source" for item in files}
    copied = copy.deepcopy(feature_collection)
    for feature in copied.get("features", []):
        source_file = feature.get("properties", {}).get("source_file")
        if source_file in stem_to_type:
            feature["feature_type"] = stem_to_type[source_file]
    return copied


def infer_learning_suggestion(
    files: list[ImportedFile],
    changed_stem: str,
    new_type: str,
    keywords: dict[str, set[str]],
) -> LearningSuggestion | None:
    target = next((item for item in files if item.stem == changed_stem), None)
    if target is None:
        return None

    suffix_token = stem_suffix_token(changed_stem)
    if not suffix_token:
        return None

    affected_stems = [
        item.stem
        for item in files
        if item.stem != changed_stem
        and stem_suffix_token(item.stem) == suffix_token
        and (item.detected_type or "") != new_type
    ]
    if not affected_stems:
        return None

    return LearningSuggestion(
        source_stem=changed_stem,
        keyword=suffix_token,
        feature_type=new_type,
        affected_stems=affected_stems,
        message=(
            f"Apply suffix '{suffix_token}' as {new_type} keyword to "
            f"{len(affected_stems)} other files?"
        ),
    )
