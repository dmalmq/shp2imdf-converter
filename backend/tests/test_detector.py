"""Detector tests for Phase 2."""

from __future__ import annotations

import pytest

from backend.src.detector import (
    detect_feature_type,
    detect_files,
    detect_floor_label,
    detect_level_ordinal,
    detect_levels,
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
def test_detect_feature_type_drawing_suffix_maps_to_detail() -> None:
    keyword_map = {"unit": {"space"}, "opening": {"opening"}}
    detected_type, confidence = detect_feature_type("JRShinjukuSta_1_Drawing", "LineString", keyword_map)
    assert detected_type == "detail"
    assert confidence == "green"


@pytest.mark.phase2
def test_detect_level_patterns() -> None:
    assert detect_level_ordinal("Station_B1_Space") == -1
    assert detect_level_ordinal("Station_-2_Opening") == -2
    assert detect_level_ordinal("Station_GF_Space") == 0
    assert detect_level_ordinal("Station_GH_Space") == 0
    assert detect_level_ordinal("Station_1_Space") == 0
    assert detect_level_ordinal("Station_3_Space") == 2
    assert detect_level_ordinal("Station_B1F_Space") == -1
    assert detect_level_ordinal("Station_B2F_Opening") == -2
    assert detect_level_ordinal("Station_B3F_Detail") == -3
    # FL suffix: 1FL, B1FL増築会階
    assert detect_level_ordinal("JRTokyoSt_壁あり_2024_1FL_floor_unit") == 0
    assert detect_level_ordinal("JRTokyoSt_壁あり_2024_B1FL_floor_unit") == -1
    assert detect_level_ordinal("JRTokyoSt_壁あり_2024_B4FL_総武線コンコース_floor_unit") == -4
    # Years in filenames must not be mistaken for floor ordinals
    assert detect_level_ordinal("Demo_2024_1F_Floor") == 0
    assert detect_level_ordinal("Demo_2024_B1F_Floor") == -1


@pytest.mark.phase2
def test_detect_files_applies_learning_keywords() -> None:
    base = {"unit": {"space"}, "opening": {"opening"}}
    merged = merge_learned_keywords(base, {"suffix:tila": "unit"})
    files = [
        ImportedFile(
            stem="Shinjuku_Tila_B1",
            geometry_type="LineString",
            feature_count=1,
            attribute_columns=[],
        ),
        ImportedFile(
            stem="Shinjuku_TilaWing_B1",
            geometry_type="LineString",
            feature_count=1,
            attribute_columns=[],
        ),
    ]
    detected = detect_files(files, merged, preserve_manual_levels=False)
    assert detected[0].detected_type == "unit"
    assert detected[0].confidence == "green"
    assert detected[1].detected_type == "opening"
    assert detected[1].confidence == "yellow"


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
def test_infer_learning_suggestion_uses_suffix_token() -> None:
    keyword_map = {"unit": {"unit"}, "detail": {"detail"}}
    files = [
        ImportedFile(
            stem="JRShinjukuSta_1_Space",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=[],
            detected_type="detail",
            confidence="yellow",
        ),
        ImportedFile(
            stem="JRShinjukuSta_2_Space",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=[],
            detected_type="detail",
            confidence="yellow",
        ),
        ImportedFile(
            stem="JRShinjukuSta_1_Drawing",
            geometry_type="LineString",
            feature_count=1,
            attribute_columns=[],
            detected_type="detail",
            confidence="green",
        ),
    ]
    suggestion = infer_learning_suggestion(files, "JRShinjukuSta_1_Space", "unit", keyword_map)
    assert suggestion is not None
    assert suggestion.keyword == "space"
    assert suggestion.feature_type == "unit"
    assert suggestion.affected_stems == ["JRShinjukuSta_2_Space"]


@pytest.mark.phase2
def test_load_keyword_map(config_path="backend/config/filename_keywords.json") -> None:
    loaded = load_keyword_map(config_path)
    assert "unit" in loaded
    assert "space" in loaded["unit"]
    assert "amenity" in loaded
    assert "amenity" in loaded["amenity"]


@pytest.mark.phase2
@pytest.mark.parametrize(
    ("stem", "label"),
    [
        ("Site_M1F_Space", "M1F"),
        ("Site_M1_Space", "M1F"),
        ("Site_M2FL_Space", "M2F"),
        ("JRTokyoSta_M2_Space", "M2F"),
        ("Site_RF_Space", "RF"),
        ("Site_R_Space", "RF"),
        ("Site_PH_Space", "RF"),
        ("Site_屋上_Space", "RF"),
        ("Site_2F_Space", None),
        ("Site_B1_Space", None),
        ("Site_Room_Space", None),
    ],
)
def test_detect_floor_label_names_mezzanines_and_the_roof(stem: str, label: str | None) -> None:
    assert detect_floor_label(stem) == label


def _levels(stems: list[str]) -> dict[str, tuple[int, str | None, bool]]:
    return {stem: (level.ordinal, level.short_name, level.outdoor) for stem, level in detect_levels(stems).items()}


@pytest.mark.phase2
def test_a_mezzanine_stacks_between_its_floors_and_moves_the_floors_above_up() -> None:
    # Shinjuku and Tokyo: M2F lies over 1F and under 2F, so 1F 0, M2F 1, 2F 2.
    assert _levels(["S_B1_Space", "S_1F_Space", "S_M2F_Space", "S_2F_Space", "S_3F_Space", "S_RF_Space"]) == {
        "S_B1_Space": (-1, None, False),
        "S_1F_Space": (0, None, False),
        "S_M2F_Space": (1, "M2F", False),
        "S_2F_Space": (2, "2F", False),
        "S_3F_Space": (3, "3F", False),
        "S_RF_Space": (4, "RF", True),
    }


@pytest.mark.phase2
def test_m1f_shares_the_slot_above_the_ground_floor() -> None:
    assert _levels(["S_1F_Space", "S_M1F_Space", "S_M2F_Space", "S_2F_Space"]) == {
        "S_1F_Space": (0, None, False),
        "S_M1F_Space": (1, "M1F", False),
        "S_M2F_Space": (2, "M2F", False),
        "S_2F_Space": (3, "2F", False),
    }


@pytest.mark.phase2
def test_without_a_mezzanine_ordinals_are_unchanged_and_the_roof_goes_on_top() -> None:
    assert _levels(["S_B1_Space", "S_1_Space", "S_2_Space", "S_屋上_Space", "S_Building"]) == {
        "S_B1_Space": (-1, None, False),
        "S_1_Space": (0, None, False),
        "S_2_Space": (1, None, False),
        "S_屋上_Space": (2, "RF", True),
    }


@pytest.mark.phase2
def test_detect_files_labels_a_mezzanine_and_keeps_manual_levels() -> None:
    keywords = {"unit": {"space"}}
    files = [
        ImportedFile(stem=stem, geometry_type="Polygon", feature_count=1, attribute_columns=[])
        for stem in ["S_1F_Space", "S_M2F_Space", "S_2F_Space", "S_RF_Space"]
    ]
    detected = {item.stem: item for item in detect_files(files, keywords, preserve_manual_levels=False)}
    assert [(detected[stem].detected_level, detected[stem].short_name, detected[stem].outdoor) for stem in detected] == [
        (0, None, False),
        (1, "M2F", False),
        (2, "2F", False),
        (3, "RF", True),
    ]

    detected["S_2F_Space"].detected_level = 7
    detected["S_2F_Space"].short_name = "Upper"
    again = {item.stem: item for item in detect_files(list(detected.values()), keywords, preserve_manual_levels=True)}
    assert (again["S_2F_Space"].detected_level, again["S_2F_Space"].short_name) == (7, "Upper")


@pytest.mark.phase2
@pytest.mark.parametrize(
    ("stem", "geometry"),
    [
        ("新宿周辺_街区", "Polygon"),
        ("新宿周辺_軌道の中心線_JR", "LineString"),
        ("新宿周辺_その他の構造物_歩道橋_跨線橋", "Polygon"),
        ("新宿周辺_建物", "Mixed"),
        ("Shinjuku_surrounding_roads", "Polygon"),
    ],
)
def test_surrounding_map_layers_are_settled_as_unknown(stem: str, geometry: str) -> None:
    keyword_map = load_keyword_map("backend/config/filename_keywords.json")

    assert detect_feature_type(stem, geometry, keyword_map) == ("unknown", "green")


@pytest.mark.phase2
def test_a_floor_layer_that_mentions_its_surroundings_keeps_its_type() -> None:
    keyword_map = load_keyword_map("backend/config/filename_keywords.json")

    assert detect_feature_type("JRShinjukuSta_1_改札周辺_Space", "Polygon", keyword_map) == ("unit", "green")
    # "surrounding" is the longer keyword here, and must still lose to the IMDF one.
    assert detect_feature_type("Station_1_surrounding_Space", "Polygon", keyword_map) == ("unit", "green")
    assert detect_feature_type("Station_1_surrounding_Opening", "LineString", keyword_map) == ("opening", "green")


@pytest.mark.phase2
def test_a_learned_suffix_for_unknown_still_wins() -> None:
    keyword_map = merge_learned_keywords(
        load_keyword_map("backend/config/filename_keywords.json"), {"suffix:bg": "unknown"}
    )

    assert detect_feature_type("Station_1_Space_bg", "Polygon", keyword_map) == ("unknown", "green")


def _detected_levels(stems_and_geometry: list[tuple[str, str]]) -> dict[str, tuple[str | None, int | None, str | None]]:
    keywords = {"unit": {"space"}, "building": {"building"}, "amenity": {"amenity"}}
    files = [
        ImportedFile(stem=stem, geometry_type=geometry, feature_count=1, attribute_columns=[])
        for stem, geometry in stems_and_geometry
    ]
    return {
        item.stem: (item.detected_type, item.detected_level, item.short_name)
        for item in detect_files(files, keywords, preserve_manual_levels=False)
    }


@pytest.mark.phase2
def test_a_file_that_draws_no_floor_does_not_lift_the_roof() -> None:
    detected = _detected_levels(
        [("Station_1F_Space", "Polygon"), ("Station_2F_Space", "Polygon"), ("Station_RF_Space", "Polygon"), ("Station_10_Building", "Polygon")]
    )
    assert detected == {
        "Station_1F_Space": ("unit", 0, None),
        "Station_2F_Space": ("unit", 1, None),
        "Station_RF_Space": ("unit", 2, "RF"),
        "Station_10_Building": ("building", 9, None),
    }


@pytest.mark.phase2
def test_a_stray_mezzanine_label_moves_no_floor() -> None:
    detected = _detected_levels(
        [
            ("Station_1F_Space", "Polygon"),
            ("Station_2F_Space", "Polygon"),
            ("Station_3F_Space", "Polygon"),
            ("Station_2F_Amenity", "Point"),
            ("Station_M2F_Amenity", "Point"),
        ]
    )
    assert detected == {
        "Station_1F_Space": ("unit", 0, None),
        "Station_2F_Space": ("unit", 1, None),
        "Station_3F_Space": ("unit", 2, None),
        "Station_2F_Amenity": ("amenity", 1, None),
        "Station_M2F_Amenity": ("amenity", None, None),
    }


@pytest.mark.phase2
def test_files_that_draw_no_floor_follow_a_real_mezzanine() -> None:
    detected = _detected_levels(
        [
            ("Station_1F_Space", "Polygon"),
            ("Station_M2F_Space", "Polygon"),
            ("Station_2F_Space", "Polygon"),
            ("Station_M2F_Amenity", "Point"),
            ("Station_2F_Amenity", "Point"),
            ("Station_RF_Amenity", "Point"),
        ]
    )
    assert detected == {
        "Station_1F_Space": ("unit", 0, None),
        "Station_M2F_Space": ("unit", 1, "M2F"),
        "Station_2F_Space": ("unit", 2, "2F"),
        "Station_M2F_Amenity": ("amenity", 1, "M2F"),
        "Station_2F_Amenity": ("amenity", 2, "2F"),
        "Station_RF_Amenity": ("amenity", 3, "RF"),
    }
