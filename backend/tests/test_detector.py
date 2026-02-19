"""Detector tests for Phase 2."""

from __future__ import annotations

import pytest

from backend.src.detector import (
    detect_feature_type,
    detect_files,
    detect_level_ordinal,
    infer_learning_suggestion,
    load_keyword_map,
    merge_learned_keywords,
)
from backend.src.schemas import ImportedFile


@pytest.mark.phase2
def test_detect_feature_type_keyword_match() -> None:
    keyword_map = {"unit": {"space"}, "opening": {"opening"}}
    detected_type, confidence = detect_feature_type("JRTokyoSta_B1_Space", "Polygon", keyword_map)
    assert detected_type == "unit"
    assert confidence == "green"


@pytest.mark.phase2
def test_detect_level_patterns() -> None:
    assert detect_level_ordinal("Station_B1_Space") == -1
    assert detect_level_ordinal("Station_-2_Opening") == -2
    assert detect_level_ordinal("Station_GF_Space") == 0
    assert detect_level_ordinal("Station_1_Space") == 1


@pytest.mark.phase2
def test_detect_files_applies_learning_keywords() -> None:
    base = {"unit": {"space"}, "opening": {"opening"}}
    merged = merge_learned_keywords(base, {"tila": "unit"})
    files = [
        ImportedFile(
            stem="Shinjuku_Tila_B1",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=[],
        )
    ]
    detected = detect_files(files, merged, preserve_manual_levels=False)
    assert detected[0].detected_type == "unit"
    assert detected[0].confidence == "green"


@pytest.mark.phase2
def test_infer_learning_suggestion_from_relabel() -> None:
    keyword_map = {"unit": {"space"}, "opening": {"opening"}}
    files = [
        ImportedFile(
            stem="Shinjuku_Tila_B1",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=[],
            detected_type="unit",
            confidence="green",
        ),
        ImportedFile(
            stem="Shinjuku_Tila_GF",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=[],
            detected_type="opening",
            confidence="yellow",
        ),
    ]
    suggestion = infer_learning_suggestion(files, "Shinjuku_Tila_B1", "unit", keyword_map)
    assert suggestion is not None
    assert suggestion.keyword == "tila"
    assert suggestion.feature_type == "unit"
    assert suggestion.affected_stems == ["Shinjuku_Tila_GF"]


@pytest.mark.phase2
def test_load_keyword_map(config_path="backend/config/filename_keywords.json") -> None:
    loaded = load_keyword_map(config_path)
    assert "unit" in loaded
    assert "space" in loaded["unit"]

