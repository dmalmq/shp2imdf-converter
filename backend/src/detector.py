"""Filename/geometry detection and session-learning helpers."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
import copy
from dataclasses import dataclass
import json
from pathlib import Path
import re

from backend.src.schemas import ImportedFile, LearningSuggestion


UNKNOWN_TYPE = "unknown"

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
    # "Unknown, decide later": not an IMDF type, and the generator and the exports pass
    # over a file of a type they do not know, so it is left out until a real one is picked.
    UNKNOWN_TYPE,
}


def _is_level_token(token: str) -> bool:
    lowered = token.lower()
    if lowered.isdigit():
        return True
    if re.fullmatch(r"b\d+", lowered):
        return True
    if lowered in {"g", "gf", "gh"}:
        return True
    return detect_floor_label(token) is not None


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

    # Ranked by: an exact suffix rule, then any IMDF type over "unknown"
    # (Station_1_surrounding_Space is a unit layer), then the longest keyword.
    best_match: tuple[str, tuple[bool, bool, int]] | None = None
    for feature_type, values in keywords.items():
        for keyword in values:
            candidate = keyword.lower().strip()
            if not candidate:
                continue

            if candidate.startswith("suffix:"):
                expected_suffix = candidate[len("suffix:") :]
                if suffix_token != expected_suffix:
                    continue
                rank = (True, feature_type != UNKNOWN_TYPE, len(expected_suffix))
            elif candidate in lowered:
                rank = (False, feature_type != UNKNOWN_TYPE, len(candidate))
            else:
                continue
            if best_match is None or rank > best_match[1]:
                best_match = (feature_type, rank)

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


ROOF_LABEL = "RF"
_ROOF_TOKENS = {"RF", "R", "PH"}


def canonical_floor_label(text: str | None) -> str | None:
    """Canonical floor code for floor-label text: "2FL"/"2F" -> "2F", "B1FL"/"B1" -> "B1F",
    "M2FL"/"M2" -> "M2F". Bare digits are not a label, so a year such as 2024 is not a floor."""
    if not text:
        return None
    match = re.fullmatch(r"\s*(B|M)?(\d+)FL?\s*", text, re.IGNORECASE) or re.fullmatch(
        r"\s*(B|M)(\d+)\s*", text, re.IGNORECASE
    )
    if not match:
        return None
    return f"{(match.group(1) or '').upper()}{int(match.group(2))}F"


def detect_floor_label(stem: str) -> str | None:
    """The mezzanine ("M2F") or roof ("RF") label a stem names, else None. Plain floors
    need no label: `detect_level_ordinal` numbers them."""
    if "屋上" in stem:
        return ROOF_LABEL
    for token in re.findall(r"[A-Za-z0-9]+", stem):
        if token.upper() in _ROOF_TOKENS:
            return ROOF_LABEL
        code = canonical_floor_label(token)
        if code and code.startswith("M"):
            return code
    return None


def default_short_name(ordinal: int) -> str:
    """Japanese floor convention, the inverse of `detect_level_ordinal`: 0 is 1F, -1 is B1F."""
    return f"B{abs(ordinal)}F" if ordinal < 0 else f"{ordinal + 1}F"


@dataclass(frozen=True)
class DetectedLevel:
    ordinal: int
    short_name: str | None
    outdoor: bool = False


def _mezzanine_slot(label: str) -> tuple[int, int]:
    # M<n>F sits between floors n-1 and n (中n階), so M2F is between 1F and 2F. M1F
    # takes the same slot rather than going under the ground floor, below any M2F.
    number = int(label[1:-1])
    return max(number, 2), number


def detect_levels(stems: Iterable[str]) -> dict[str, DetectedLevel]:
    """Ordinals for a set of per-floor files, decided together. Each mezzanine gets
    its own ordinal directly above floor n-1, so every floor above it moves up one
    and keeps its label as short_name; the roof goes one above the top floor and is
    outdoor. short_name is None where the ordinal's default label is already right."""
    plain: dict[str, int] = {}
    mezzanines: dict[str, str] = {}
    roofs: list[str] = []
    for stem in stems:
        label = detect_floor_label(stem)
        if label == ROOF_LABEL:
            roofs.append(stem)
        elif label is not None:
            mezzanines[stem] = label
        else:
            ordinal = detect_level_ordinal(stem)
            if ordinal is not None:
                plain[stem] = ordinal

    slots = sorted({_mezzanine_slot(label) for label in mezzanines.values()})

    def stacked(ordinal: int) -> int:
        if ordinal < 0:
            return ordinal
        floor = ordinal + 1
        return ordinal + sum(1 for slot, _ in slots if slot <= floor)

    levels: dict[str, DetectedLevel] = {}
    for stem, ordinal in plain.items():
        shifted = stacked(ordinal)
        levels[stem] = DetectedLevel(shifted, default_short_name(ordinal) if shifted != ordinal else None)
    for stem, label in mezzanines.items():
        slot = _mezzanine_slot(label)
        below = sum(1 for other in slots if other[0] == slot[0] and other < slot)
        levels[stem] = DetectedLevel(stacked(slot[0] - 2) + 1 + below, label)
    top = max((level.ordinal for level in levels.values()), default=-1)
    for stem in roofs:
        levels[stem] = DetectedLevel(top + 1, ROOF_LABEL, outdoor=True)
    return levels


def detect_files(
    files: list[ImportedFile],
    keywords: dict[str, set[str]],
    preserve_manual_levels: bool = True,
) -> list[ImportedFile]:
    levels = detect_levels(item.stem for item in files)
    detected: list[ImportedFile] = []
    for item in files:
        inferred_type, confidence = detect_feature_type(item.stem, item.geometry_type, keywords)

        updated = item.model_copy(deep=True)
        updated.detected_type = inferred_type
        updated.confidence = confidence
        if not preserve_manual_levels or updated.detected_level is None:
            level = levels.get(item.stem)
            updated.detected_level = level.ordinal if level else None
            if level and level.short_name and not updated.short_name:
                updated.short_name = level.short_name
            if level and level.outdoor:
                updated.outdoor = True
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
