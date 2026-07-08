"""Generator tests for Phase 4."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from shapely.geometry import Polygon, mapping, shape

from backend.src.generator import _carve_column_units, generate_feature_collection
from backend.src.schemas import (
    AddressInput,
    CleanupSummary,
    ImportedFile,
    ProjectWizardState,
    SessionRecord,
)

_UNIT_CATEGORIES_PATH = str(Path("backend/config/unit_categories.json"))


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in sample_dir.glob(f"{stem}.*"):
        files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
    return files


def _prepare_generated(test_client, sample_dir: Path) -> tuple[str, list[dict]]:
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
            },
        },
    )
    assert project_response.status_code == 200

    generate_response = test_client.post(f"/api/session/{session_id}/generate")
    assert generate_response.status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    return session_id, features


@pytest.mark.phase4
def test_generated_levels_have_building_ids(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    levels = [item for item in features if item["feature_type"] == "level"]
    assert levels
    for level in levels:
        properties = level["properties"]
        assert properties["building_ids"]
        assert isinstance(properties["building_ids"], list)


@pytest.mark.phase4
def test_generated_units_and_openings_reference_level_ids(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    level_ids = {item["id"] for item in features if item["feature_type"] == "level"}
    assert level_ids

    units = [item for item in features if item["feature_type"] == "unit"]
    openings = [item for item in features if item["feature_type"] == "opening"]
    assert units
    assert openings

    assert all(item["properties"]["level_id"] in level_ids for item in units)
    assert all(item["properties"]["level_id"] in level_ids for item in openings)


@pytest.mark.phase4
def test_generated_unlocated_features_have_null_geometry(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    addresses = [item for item in features if item["feature_type"] == "address"]
    buildings = [item for item in features if item["feature_type"] == "building"]
    assert addresses
    assert buildings
    assert all(item["geometry"] is None for item in addresses)
    assert all(item["geometry"] is None for item in buildings)


@pytest.mark.phase4
def test_generated_core_feature_ids_use_uuid4(test_client, sample_dir: Path) -> None:
    _, features = _prepare_generated(test_client, sample_dir)
    core_types = {"venue", "building", "level", "footprint"}
    target_rows = [item for item in features if item["feature_type"] in core_types]
    assert target_rows
    for row in target_rows:
        parsed = UUID(row["id"])
        assert parsed.version == 4


@pytest.mark.phase4
def test_venue_geometry_includes_subterranean_footprints_when_ground_exists(test_client, sample_dir: Path) -> None:
    files = _upload_payload(sample_dir, "JRTokyoSta_B1_Space") + _upload_payload(sample_dir, "JRTokyoSta_GF_Space")
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
            },
        },
    )
    assert project_response.status_code == 200

    generate_response = test_client.post(f"/api/session/{session_id}/generate")
    assert generate_response.status_code == 200

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    venue = next(item for item in features if item["feature_type"] == "venue")
    footprints = [item for item in features if item["feature_type"] == "footprint"]
    ground = [item for item in footprints if item["properties"].get("category") == "ground"]
    subterranean = [item for item in footprints if item["properties"].get("category") == "subterranean"]
    assert ground
    assert subterranean

    venue_geom = shape(venue["geometry"])
    assert all(venue_geom.intersects(shape(item["geometry"])) for item in ground)
    assert all(venue_geom.intersects(shape(item["geometry"])) for item in subterranean)


def _unit_source_row(stem: str, square: tuple[float, float]) -> dict:
    x, y = square
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "source",
        "geometry": mapping(
            Polygon([(x, y), (x + 0.0003, y), (x + 0.0003, y + 0.0003), (x, y + 0.0003), (x, y)])
        ),
        "properties": {
            "source_file": stem,
            "source_row_index": 0,
            "source_part_index": 0,
            "source_feature_ref": f"{stem}:0:0",
            "status": "mapped",
            "issues": [],
            "metadata": {"CATEGORY": "retail"},
        },
    }


def _multi_level_session(level_ordinals: list[int]) -> SessionRecord:
    """Build a session with one unit level per given ordinal (no real shapefiles)."""
    files = [
        ImportedFile(
            stem=f"unit_l{ordinal}",
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["CATEGORY"],
            detected_type="unit",
            detected_level=ordinal,
            confidence="green",
        )
        for ordinal in level_ordinals
    ]
    source_features = [
        _unit_source_row(f"unit_l{ordinal}", (139.7000 + 0.0005 * index, 35.6900))
        for index, ordinal in enumerate(level_ordinals)
    ]
    session = SessionRecord(
        session_id="footprint-dedup-session",
        created_at=datetime.now(UTC),
        last_accessed=datetime.now(UTC),
        files=files,
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": source_features},
        source_feature_collection={"type": "FeatureCollection", "features": source_features},
    )
    session.wizard.project = ProjectWizardState(
        project_name="Dedup Station",
        venue_name="Dedup Station",
        venue_category="transitstation",
        language="en",
        address=AddressInput(address="1-1 Demo", locality="Shinjuku", country="JP"),
    )
    session.wizard.mappings.unit.code_column = "CATEGORY"
    return session


@pytest.mark.phase4
def test_footprints_are_deduplicated_per_category() -> None:
    # Two subterranean levels (B1, B2) plus a ground level: previously this emitted
    # two `subterranean` footprints; it must now emit exactly one per category.
    session = _multi_level_session([-2, -1, 0, 1])
    generated = generate_feature_collection(session, unit_categories_path=_UNIT_CATEGORIES_PATH)

    footprints = [item for item in generated["features"] if item["feature_type"] == "footprint"]
    categories = [item["properties"]["category"] for item in footprints]

    assert set(categories) <= {"aerial", "ground", "subterranean"}
    assert len(categories) == len(set(categories)), f"duplicate footprint categories: {categories}"
    assert sorted(categories) == ["aerial", "ground", "subterranean"]


def _square(x: float, y: float, size: float) -> Polygon:
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)])


def _mapped_unit(category: str, polygon: Polygon, level_id: str = "level-1") -> dict:
    return {
        "type": "Feature",
        "id": str(uuid4()),
        "feature_type": "unit",
        "geometry": mapping(polygon),
        "properties": {
            "category": category,
            "level_id": level_id,
            "display_point": mapping(polygon.representative_point()),
        },
    }


@pytest.mark.phase4
def test_carve_column_units_subtracts_column_from_surrounding_unit() -> None:
    room_polygon = _square(0.0, 0.0, 0.001)
    column_polygon = _square(0.0004, 0.0004, 0.0002)
    room = _mapped_unit("room", room_polygon)
    column = _mapped_unit("column", column_polygon)
    features = [room, column]

    _carve_column_units(features)

    assert len(features) == 2
    carved_room = shape(room["geometry"])
    assert carved_room.area == pytest.approx(room_polygon.area - column_polygon.area)
    assert not carved_room.intersection(shape(column["geometry"])).area > 0
    assert shape(column["geometry"]).equals(column_polygon)
    display_point = shape(room["properties"]["display_point"])
    assert carved_room.contains(display_point)


@pytest.mark.phase4
def test_carve_column_units_ignores_non_overlapping_column() -> None:
    room_polygon = _square(0.0, 0.0, 0.001)
    room = _mapped_unit("room", room_polygon)
    column = _mapped_unit("column", _square(0.005, 0.005, 0.0002))
    features = [room, column]

    _carve_column_units(features)

    assert shape(room["geometry"]).equals(room_polygon)


@pytest.mark.phase4
def test_carve_column_units_only_applies_within_same_level() -> None:
    room_polygon = _square(0.0, 0.0, 0.001)
    room = _mapped_unit("room", room_polygon, level_id="level-1")
    column = _mapped_unit("column", _square(0.0004, 0.0004, 0.0002), level_id="level-2")
    features = [room, column]

    _carve_column_units(features)

    assert shape(room["geometry"]).equals(room_polygon)


@pytest.mark.phase4
def test_carve_column_units_removes_units_fully_covered_by_columns() -> None:
    swallowed = _mapped_unit("room", _square(0.0004, 0.0004, 0.0001))
    column = _mapped_unit("column", _square(0.0003, 0.0003, 0.0004))
    features = [swallowed, column]

    _carve_column_units(features)

    assert len(features) == 1
    assert features[0]["properties"]["category"] == "column"


@pytest.mark.phase4
def test_generate_feature_collection_carves_columns_out_of_units() -> None:
    session = _multi_level_session([0])
    room_stem = "unit_l0"
    column_stem = "unit_l0_column"
    session.files.append(
        ImportedFile(
            stem=column_stem,
            geometry_type="Polygon",
            feature_count=1,
            attribute_columns=["CATEGORY"],
            detected_type="unit",
            detected_level=0,
            confidence="green",
        )
    )
    room_row = session.source_feature_collection["features"][0]
    room_polygon = shape(room_row["geometry"])
    column_row = _unit_source_row(column_stem, (139.7000, 35.6900))
    column_polygon = _square(139.7001, 35.69001, 0.0001)
    column_row["geometry"] = mapping(column_polygon)
    column_row["properties"]["metadata"] = {"CATEGORY": "column"}
    session.source_feature_collection["features"].append(column_row)
    session.feature_collection = session.source_feature_collection

    generated = generate_feature_collection(session, unit_categories_path=_UNIT_CATEGORIES_PATH)

    units = [item for item in generated["features"] if item["feature_type"] == "unit"]
    categories = {item["properties"]["category"] for item in units}
    assert "column" in categories
    column_unit = next(item for item in units if item["properties"]["category"] == "column")
    other_unit = next(item for item in units if item["properties"]["category"] != "column")
    assert shape(column_unit["geometry"]).equals_exact(column_polygon, tolerance=1e-12)
    carved = shape(other_unit["geometry"])
    assert carved.area == pytest.approx(room_polygon.area - column_polygon.area)
    assert carved.intersection(shape(column_unit["geometry"])).area == pytest.approx(0.0)
