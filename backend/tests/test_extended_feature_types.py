"""Extended IMDF feature type support tests."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from shapely.geometry import LineString, Point, Polygon, mapping

from backend.src.converter import build_imdf_geojson_files
from backend.src.generator import generate_feature_collection
from backend.src.schemas import AddressInput, CleanupSummary, ImportedFile, ProjectWizardState, SessionRecord


def _source_row(stem: str, feature_id: str, geometry: dict, metadata: dict) -> dict:
    return {
        "type": "Feature",
        "id": feature_id,
        "feature_type": "source",
        "geometry": geometry,
        "properties": {
            "source_file": stem,
            "source_row_index": 0,
            "source_part_index": 0,
            "source_feature_ref": f"{stem}:0:0",
            "status": "mapped",
            "issues": [],
            "metadata": metadata,
        },
    }


def _sample_session() -> SessionRecord:
    unit_id = "11111111-1111-4111-8111-111111111111"
    amenity_id = "22222222-2222-4222-8222-222222222222"
    anchor_id = "33333333-3333-4333-8333-333333333333"
    geofence_id = "44444444-4444-4444-8444-444444444444"
    kiosk_id = "55555555-5555-4555-8555-555555555555"
    occupant_id = "66666666-6666-4666-8666-666666666666"
    relationship_id = "77777777-7777-4777-8777-777777777777"
    section_id = "88888888-8888-4888-8888-888888888888"
    facility_id = "99999999-9999-4999-8999-999999999999"

    files = [
        ImportedFile(
            stem="demo_unit",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["CATEGORY"],
            detected_type="unit",
            detected_level=0,
            level_name="Ground",
            short_name="GH",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_amenity",
            geometry_type="Point",
            feature_count=1,
            attribute_columns=["category", "unit_ids", "name"],
            detected_type="amenity",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_anchor",
            geometry_type="Point",
            feature_count=1,
            attribute_columns=["unit_id"],
            detected_type="anchor",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_geofence",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["category", "feature_ids"],
            detected_type="geofence",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_kiosk",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["name", "anchor_id"],
            detected_type="kiosk",
            detected_level=0,
            confidence="green",
        ),
        ImportedFile(
            stem="demo_occupant",
            geometry_type="Point",
            feature_count=1,
            attribute_columns=["category", "name", "anchor_id"],
            detected_type="occupant",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_relationship",
            geometry_type="LineString",
            feature_count=1,
            attribute_columns=["category", "direction", "origin_id", "origin_type", "destination_id", "destination_type"],
            detected_type="relationship",
            confidence="green",
        ),
        ImportedFile(
            stem="demo_section",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["category", "name"],
            detected_type="section",
            detected_level=0,
            confidence="green",
        ),
        ImportedFile(
            stem="demo_facility",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["category", "name"],
            detected_type="facility",
            detected_level=0,
            confidence="green",
        ),
    ]

    source_features = [
        _source_row(
            "demo_unit",
            unit_id,
            mapping(
                Polygon(
                    [
                        (139.7000, 35.6900),
                        (139.7003, 35.6900),
                        (139.7003, 35.6903),
                        (139.7000, 35.6903),
                        (139.7000, 35.6900),
                    ]
                )
            ),
            {"CATEGORY": "retail"},
        ),
        _source_row(
            "demo_amenity",
            amenity_id,
            mapping(Point(139.70015, 35.69015)),
            {"category": "information", "unit_ids": unit_id, "name": "Info Desk"},
        ),
        _source_row(
            "demo_anchor",
            anchor_id,
            mapping(Point(139.70018, 35.69018)),
            {"unit_id": unit_id},
        ),
        _source_row(
            "demo_geofence",
            geofence_id,
            mapping(
                Polygon(
                    [
                        (139.70005, 35.69005),
                        (139.70025, 35.69005),
                        (139.70025, 35.69025),
                        (139.70005, 35.69025),
                        (139.70005, 35.69005),
                    ]
                )
            ),
            {"category": "geofence", "feature_ids": unit_id},
        ),
        _source_row(
            "demo_kiosk",
            kiosk_id,
            mapping(
                Polygon(
                    [
                        (139.70010, 35.69010),
                        (139.70020, 35.69010),
                        (139.70020, 35.69020),
                        (139.70010, 35.69020),
                        (139.70010, 35.69010),
                    ]
                )
            ),
            {"name": "Kiosk A", "anchor_id": anchor_id},
        ),
        _source_row(
            "demo_occupant",
            occupant_id,
            mapping(Point(139.70012, 35.69012)),
            {"category": "retail", "name": "Shop A", "anchor_id": anchor_id},
        ),
        _source_row(
            "demo_relationship",
            relationship_id,
            mapping(LineString([(139.70015, 35.69015), (139.70020, 35.69020)])),
            {
                "category": "traversal",
                "direction": "directed",
                "origin_id": unit_id,
                "origin_type": "unit",
                "destination_id": amenity_id,
                "destination_type": "amenity",
            },
        ),
        _source_row(
            "demo_section",
            section_id,
            mapping(
                Polygon(
                    [
                        (139.7000, 35.6900),
                        (139.7003, 35.6900),
                        (139.7003, 35.6903),
                        (139.7000, 35.6903),
                        (139.7000, 35.6900),
                    ]
                )
            ),
            {"category": "walkway", "name": "North Wing"},
        ),
        _source_row(
            "demo_facility",
            facility_id,
            mapping(
                Polygon(
                    [
                        (139.70005, 35.69005),
                        (139.70010, 35.69005),
                        (139.70010, 35.69010),
                        (139.70005, 35.69010),
                        (139.70005, 35.69005),
                    ]
                )
            ),
            {"category": "legacyfacility", "name": "Legacy Facility"},
        ),
    ]

    session = SessionRecord(
        session_id="extended-types-session",
        created_at=datetime.now(UTC),
        last_accessed=datetime.now(UTC),
        files=files,
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": source_features},
        source_feature_collection={"type": "FeatureCollection", "features": source_features},
    )
    session.wizard.project = ProjectWizardState(
        project_name="Demo Station",
        venue_name="Demo Station",
        venue_category="transitstation",
        language="en",
        address=AddressInput(
            address="1-1 Demo Street",
            locality="Shinjuku",
            country="JP",
        ),
    )
    session.wizard.mappings.unit.code_column = "CATEGORY"
    return session


@pytest.mark.phase4
def test_generator_includes_extended_feature_types() -> None:
    session = _sample_session()
    generated = generate_feature_collection(session, unit_categories_path=str(Path("backend/config/unit_categories.json")))

    features = generated["features"]
    by_type: dict[str, list[dict]] = {}
    for item in features:
        by_type.setdefault(item["feature_type"], []).append(item)

    for expected_type in ("amenity", "anchor", "geofence", "kiosk", "occupant", "relationship", "section", "facility"):
        assert expected_type in by_type
        assert by_type[expected_type]

    amenity = by_type["amenity"][0]
    anchor = by_type["anchor"][0]
    occupant = by_type["occupant"][0]
    relationship = by_type["relationship"][0]
    level_ids = {item["id"] for item in by_type.get("level", [])}

    assert amenity["geometry"]["type"] == "Point"
    assert anchor["geometry"]["type"] == "Point"
    assert occupant["geometry"] is None
    assert relationship["properties"]["direction"] == "directed"
    assert relationship["properties"]["origin"]["feature_type"] == "unit"
    assert relationship["properties"]["destination"]["feature_type"] == "amenity"

    kiosk = by_type["kiosk"][0]
    section = by_type["section"][0]
    assert kiosk["properties"]["level_id"] in level_ids
    assert section["properties"]["level_id"] in level_ids


@pytest.mark.phase5
def test_converter_exports_extended_feature_files() -> None:
    session = _sample_session()
    generated = generate_feature_collection(session, unit_categories_path=str(Path("backend/config/unit_categories.json")))
    files = build_imdf_geojson_files(generated)

    for expected in (
        "amenity.geojson",
        "anchor.geojson",
        "geofence.geojson",
        "kiosk.geojson",
        "occupant.geojson",
        "relationship.geojson",
        "section.geojson",
        "facility.geojson",
    ):
        assert expected in files
        assert files[expected]["features"]


@pytest.mark.phase4
def test_generator_reuses_uploaded_venue_and_building_when_present() -> None:
    session = _sample_session()
    source_building_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    source_venue_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    session.files.append(
        ImportedFile(
            stem="demo_building",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["name", "category"],
            detected_type="building",
            confidence="green",
        )
    )
    session.files.append(
        ImportedFile(
            stem="demo_venue",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["name", "category"],
            detected_type="venue",
            confidence="green",
        )
    )

    source_rows = list(session.source_feature_collection["features"])
    source_rows.append(
        _source_row(
            "demo_building",
            source_building_id,
            mapping(
                Polygon(
                    [
                        (139.7000, 35.6900),
                        (139.7004, 35.6900),
                        (139.7004, 35.6904),
                        (139.7000, 35.6904),
                        (139.7000, 35.6900),
                    ]
                )
            ),
            {"name": "Uploaded Building", "category": "transit"},
        )
    )
    source_rows.append(
        _source_row(
            "demo_venue",
            source_venue_id,
            mapping(
                Polygon(
                    [
                        (139.6998, 35.6898),
                        (139.7006, 35.6898),
                        (139.7006, 35.6906),
                        (139.6998, 35.6906),
                        (139.6998, 35.6898),
                    ]
                )
            ),
            {"name": "Uploaded Venue", "category": "transitstation"},
        )
    )
    session.source_feature_collection = {"type": "FeatureCollection", "features": source_rows}
    session.feature_collection = {"type": "FeatureCollection", "features": source_rows}

    generated = generate_feature_collection(session, unit_categories_path=str(Path("backend/config/unit_categories.json")))
    features = generated["features"]
    buildings = [item for item in features if item["feature_type"] == "building"]
    venues = [item for item in features if item["feature_type"] == "venue"]
    levels = [item for item in features if item["feature_type"] == "level"]

    assert len(buildings) == 1
    assert len(venues) == 1
    assert buildings[0]["id"] == source_building_id
    assert venues[0]["id"] == source_venue_id
    assert buildings[0]["properties"]["name"]["en"] == "Uploaded Building"
    assert venues[0]["properties"]["name"]["en"] == "Uploaded Venue"
    assert levels
    assert all(source_building_id in level["properties"]["building_ids"] for level in levels)
