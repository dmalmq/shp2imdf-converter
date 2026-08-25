"""Validator tests for Phase 5."""

from __future__ import annotations

import copy
from pathlib import Path
from uuid import uuid4

import pytest
from shapely.geometry import MultiPolygon, Point, Polygon, mapping

from backend.src.validator import validate_feature_collection


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _generated_collection(test_client, sample_dir: Path) -> dict:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_B1_Opening")
    import_response = test_client.post("/api/import", files=files)
    session_id = import_response.json()["session_id"]

    project_response = test_client.patch(
        f"/api/session/{session_id}/wizard/project",
        json={
            "project_name": "Tokyo Station",
            "venue_name": "Tokyo Station",
            "venue_category": "transitstation",
            "language": "en",
            "address": {
                "address": "1-9-1 Marunouchi",
                "locality": "Chiyoda-ku",
                "country": "JP",
                "province": "JP-13",
            },
        },
    )
    assert project_response.status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    return test_client.get(f"/api/session/{session_id}/features").json()


@pytest.mark.phase5
def test_valid_output_passes_without_errors(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    result = validate_feature_collection(collection)
    assert result.summary.error_count == 0


@pytest.mark.phase5
def test_missing_venue_error(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    mutated["features"] = [item for item in mutated["features"] if item["feature_type"] != "venue"]
    result = validate_feature_collection(mutated)
    assert any(issue.check == "missing_venue" for issue in result.errors)


@pytest.mark.phase5
def test_duplicate_uuids_error(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    units = [item for item in mutated["features"] if item["feature_type"] == "unit"]
    assert len(units) >= 2
    units[1]["id"] = units[0]["id"]
    result = validate_feature_collection(mutated)
    assert any(issue.check == "duplicate_uuids" for issue in result.errors)


@pytest.mark.phase5
@pytest.mark.parametrize("restriction", ["employeesonly", "restricted", None])
def test_legal_restriction_is_accepted(test_client, sample_dir: Path, restriction: str | None) -> None:
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    unit = next(item for item in collection["features"] if item["feature_type"] == "unit")
    unit["properties"]["restriction"] = restriction
    result = validate_feature_collection(collection)
    assert not any(issue.check == "restriction_valid" for issue in result.errors)
    assert "restriction_valid" in result.passed


@pytest.mark.phase5
def test_restriction_outside_the_imdf_enum_is_an_error(test_client, sample_dir: Path) -> None:
    """A value the enum cannot carry used to export with nothing objecting.

    Import repairs near misses of the two legal values, so what reaches here is
    something else entirely - which makes the archive non-conformant and has to
    be corrected in the source data.
    """
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    unit = next(item for item in collection["features"] if item["feature_type"] == "unit")
    unit["properties"]["restriction"] = "staffonly"
    result = validate_feature_collection(collection)
    issues = [issue for issue in result.errors if issue.check == "restriction_valid"]
    assert [issue.feature_id for issue in issues] == [unit["id"]]
    assert "staffonly" in issues[0].message
    assert "restriction_valid" not in result.passed


@pytest.mark.phase5
def test_restriction_is_checked_on_every_feature_that_carries_one(test_client, sample_dir: Path) -> None:
    # restriction is not a unit-only property: venue, building, level and
    # section carry it too, and each is written straight from source columns.
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    flagged = []
    for feature_type in ("venue", "building", "level"):
        feature = next(item for item in collection["features"] if item["feature_type"] == feature_type)
        feature["properties"]["restriction"] = "enpliyeesonly"
        flagged.append(feature["id"])
    result = validate_feature_collection(collection)
    issues = [issue for issue in result.errors if issue.check == "restriction_valid"]
    assert sorted(issue.feature_id for issue in issues) == sorted(flagged)



def _address_feature(collection: dict) -> dict:
    return next(item for item in collection["features"] if item["feature_type"] == "address")


@pytest.mark.phase5
def test_address_with_valid_iso_codes_has_no_address_errors(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    result = validate_feature_collection(collection)
    assert not any(issue.check.startswith("address_") for issue in result.errors)


@pytest.mark.phase5
def test_address_province_name_flagged_as_invalid_iso(test_client, sample_dir: Path) -> None:
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    _address_feature(collection)["properties"]["province"] = "JP-13 Tokyo"
    result = validate_feature_collection(collection)
    assert any(issue.check == "address_invalid_province" for issue in result.errors)


@pytest.mark.phase5
def test_address_province_country_mismatch_flagged(test_client, sample_dir: Path) -> None:
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    _address_feature(collection)["properties"]["province"] = "US-CA"
    result = validate_feature_collection(collection)
    assert any(issue.check == "address_province_country_mismatch" for issue in result.errors)


@pytest.mark.phase5
def test_address_invalid_country_flagged(test_client, sample_dir: Path) -> None:
    collection = copy.deepcopy(_generated_collection(test_client, sample_dir))
    _address_feature(collection)["properties"]["country"] = "ZZ"
    result = validate_feature_collection(collection)
    assert any(issue.check == "address_invalid_country" for issue in result.errors)


@pytest.mark.phase5
def test_opening_must_be_linestring(test_client, sample_dir: Path) -> None:
    collection = _generated_collection(test_client, sample_dir)
    mutated = copy.deepcopy(collection)
    opening = next(item for item in mutated["features"] if item["feature_type"] == "opening")
    opening["geometry"] = {
        "type": "Polygon",
        "coordinates": [[[139.0, 35.0], [139.0, 35.001], [139.001, 35.001], [139.0, 35.0]]],
    }
    result = validate_feature_collection(mutated)
    assert any(issue.check == "opening_must_be_linestring" for issue in result.errors)


@pytest.mark.phase5
def test_invalid_geometry_with_display_point_does_not_crash_validation() -> None:
    invalid_unit = MultiPolygon(
        [
            Polygon([(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)]),
            Polygon([(2, -1), (6, -1), (6, 3), (2, 3), (2, -1)]),
        ]
    )
    collection = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": str(uuid4()),
                "feature_type": "unit",
                "geometry": mapping(invalid_unit),
                "properties": {
                    "category": "room",
                    "level_id": str(uuid4()),
                    "display_point": mapping(Point(2, 2)),
                    "name": {"en": "Broken Unit"},
                },
            }
        ],
    }

    result = validate_feature_collection(collection)

    assert any(issue.check == "invalid_geometry" for issue in result.errors)


def _floor_collection() -> dict:
    # B1 and B2 level footprints overlap, exactly like 新宿: geometry cannot tell
    # which floor a feature belongs to, only the source filename can.
    footprint = Polygon([(0.0, 0.0), (0.001, 0.0), (0.001, 0.001), (0.0, 0.001), (0.0, 0.0)])
    inner = Polygon([(0.0002, 0.0002), (0.0004, 0.0002), (0.0004, 0.0004), (0.0002, 0.0004), (0.0002, 0.0002)])
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "b1-level",
                "feature_type": "level",
                "geometry": mapping(footprint),
                "properties": {"ordinal": -1, "short_name": {"en": "B1"}, "name": {"en": "B1ラチ内"}, "outdoor": False},
            },
            {
                "type": "Feature",
                "id": "b2-level",
                "feature_type": "level",
                "geometry": mapping(footprint),
                "properties": {"ordinal": -2, "short_name": {"en": "B2"}, "name": {"en": "B2ラチ内"}, "outdoor": False},
            },
            {
                "type": "Feature",
                "id": "b2-unit",
                "feature_type": "unit",
                "geometry": mapping(inner),
                "properties": {"level_id": "b1-level", "category": "stairs", "source_file": "JRShinjukuSta_B2_unit"},
            },
            {
                "type": "Feature",
                "id": "b1-unit",
                "feature_type": "unit",
                "geometry": mapping(inner),
                "properties": {"level_id": "b1-level", "category": "stairs", "source_file": "JRShinjukuSta_B1_unit"},
            },
        ],
    }


@pytest.mark.phase5
def test_validator_flags_features_whose_level_is_on_another_floor() -> None:
    response = validate_feature_collection(_floor_collection())
    mismatches = [issue for issue in response.warnings if issue.check == "level_floor_mismatch"]

    assert [issue.feature_id for issue in mismatches] == ["b2-unit"]
    assert "B2" in mismatches[0].message and "B1" in mismatches[0].message
    assert mismatches[0].related_feature_id == "b1-level"


@pytest.mark.phase5
def test_validator_summarizes_nameless_spaces_per_category() -> None:
    collection = _floor_collection()
    collection["features"].append(
        {
            "type": "Feature",
            "id": "named-unit",
            "feature_type": "unit",
            "geometry": collection["features"][-1]["geometry"],
            "properties": {"level_id": "b1-level", "category": "retail", "name": {"en": "Shop A"}, "source_file": "JRShinjukuSta_B1_unit"},
        }
    )
    response = validate_feature_collection(collection)
    nameless = [issue for issue in response.warnings if issue.check == "space_missing_name"]

    # One warning per category, and the named retail unit is not in it.
    assert [issue.message for issue in nameless] == ["2 space(s) of category STAIRS have no name."]
