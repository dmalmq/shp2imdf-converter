"""Re-typing a feature in the review editor.

Import classifies a whole shapefile at once, so a file of geofence polygons that
does not match a geofence filename keyword arrives as units. These cover the
correction path: change one feature's IMDF type, or a whole selection's, and
have its properties land in the target type's schema.
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from backend.src.converter import IMDF_TYPE_ORDER
from backend.src.feature_types import (
    FEATURE_TYPE_SPECS,
    conform_properties,
    feature_type_catalog,
    geometry_is_compatible,
    resolve_category,
)


def _upload_payload(sample_dir: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
    return [
        ("files", (path.name, path.read_bytes(), "application/octet-stream"))
        for path in sample_dir.glob(f"{stem}.*")
    ]


def _generated_session(test_client, sample_dir: Path) -> str:
    """Import the sample floor and run generation, returning the session id."""
    import_response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = import_response.json()["session_id"]
    assert test_client.patch(
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
    ).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    return session_id


def _units(test_client, session_id: str) -> list[dict]:
    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    return [item for item in features if item["feature_type"] == "unit"]


@pytest.mark.phase4
def test_registry_covers_every_exported_imdf_type() -> None:
    assert set(FEATURE_TYPE_SPECS) == set(IMDF_TYPE_ORDER)


@pytest.mark.phase4
def test_conform_properties_moves_a_unit_onto_the_geofence_schema() -> None:
    conformed = conform_properties(
        {
            "category": "road",
            "accessibility": ["wheelchair"],
            "name": {"ja": "泉岳寺辻広場"},
            "level_id": "0d662ba7-e990-44b2-8559-d3aa86cdfdd9",
            "display_point": {"type": "Point", "coordinates": [139.741, 35.637]},
            "status": "mapped",
            "issues": [],
            "metadata": {"CODE": "B0001"},
            "source_file": "JRTokyoSta_B1_Space",
        },
        "geofence",
    )

    # "road" is a unit category with no geofence counterpart, so it falls back.
    assert conformed["category"] == "geofence"
    # Floor membership is spelled level_ids on a geofence; losing it would
    # orphan the feature from its level.
    assert conformed["level_ids"] == ["0d662ba7-e990-44b2-8559-d3aa86cdfdd9"]
    assert "level_id" not in conformed
    # Unit-only fields must not survive into geofence.geojson.
    assert "accessibility" not in conformed
    # Seeded as a list because the validator requires an array here.
    assert conformed["feature_ids"] == []
    assert conformed["name"] == {"ja": "泉岳寺辻広場"}
    assert conformed["metadata"] == {"CODE": "B0001"}
    assert conformed["source_file"] == "JRTokyoSta_B1_Space"


@pytest.mark.phase4
def test_conform_properties_keeps_a_category_the_target_type_accepts() -> None:
    assert conform_properties({"category": "platform"}, "geofence")["category"] == "platform"
    assert resolve_category("PLATFORM", "geofence") == "platform"
    assert resolve_category(None, "unit") == "unspecified"
    # Open vocabulary constrained by a pattern rather than an enum.
    assert resolve_category("retail.grocery", "occupant") == "retail.grocery"
    assert resolve_category("Not A Category", "occupant") == "occupant"


@pytest.mark.phase4
def test_geometry_families_gate_the_reachable_types() -> None:
    polygon = {"type": "Polygon", "coordinates": []}
    assert geometry_is_compatible(polygon, "geofence")
    assert geometry_is_compatible(polygon, "section")
    assert not geometry_is_compatible(polygon, "detail")
    assert not geometry_is_compatible(polygon, "amenity")
    assert not geometry_is_compatible(polygon, "address")
    assert geometry_is_compatible(None, "occupant")
    # relationship accepts any geometry.
    assert geometry_is_compatible(polygon, "relationship")
    assert geometry_is_compatible(None, "relationship")


@pytest.mark.phase4
def test_feature_type_catalog_describes_categories_and_geometry() -> None:
    catalog = {item["feature_type"]: item for item in feature_type_catalog()}
    assert [item["feature_type"] for item in feature_type_catalog()] == IMDF_TYPE_ORDER

    geofence = catalog["geofence"]
    assert geofence["geometry"] == "polygon"
    assert geofence["has_category"] is True
    assert "platform" in geofence["categories"]
    assert "road" not in geofence["categories"]
    assert geofence["default_category"] == "geofence"

    # Units are offered the wizard's catalog, which is the superset.
    assert {"road", "retail", "transit"} <= set(catalog["unit"]["categories"])

    # Kiosks have no category in IMDF; details are line features.
    assert catalog["kiosk"]["has_category"] is False
    assert catalog["kiosk"]["categories"] is None
    assert catalog["detail"]["geometry"] == "line"

    # Occupant categories are an open vocabulary.
    assert catalog["occupant"]["has_category"] is True
    assert catalog["occupant"]["categories"] is None


@pytest.mark.phase4
def test_feature_types_endpoint_serves_the_catalog(test_client) -> None:
    response = test_client.get("/api/reference/feature-types")
    assert response.status_code == 200
    payload = response.json()["feature_types"]
    assert [item["feature_type"] for item in payload] == IMDF_TYPE_ORDER


@pytest.mark.phase4
def test_patch_retypes_a_unit_into_a_geofence(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = _units(test_client, session_id)[0]
    level_id = unit["properties"]["level_id"]

    response = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "geofence"},
    )

    assert response.status_code == 200
    updated = response.json()
    assert updated["id"] == unit["id"]
    assert updated["feature_type"] == "geofence"
    assert updated["properties"]["category"] == "geofence"
    assert updated["properties"]["level_ids"] == [level_id]
    assert "level_id" not in updated["properties"]
    assert updated["geometry"] == unit["geometry"]

    # The change is persisted, not just echoed back.
    refetched = test_client.get(f"/api/session/{session_id}/features/{unit['id']}").json()
    assert refetched["feature_type"] == "geofence"


@pytest.mark.phase4
def test_patch_applies_an_explicit_category_over_the_retype_default(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = _units(test_client, session_id)[0]

    response = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "geofence", "properties": {"category": "platform"}},
    )

    assert response.status_code == 200
    assert response.json()["properties"]["category"] == "platform"


@pytest.mark.phase4
def test_retype_wins_over_the_old_type_fields_the_editor_posts_back(test_client, sample_dir: Path) -> None:
    """The properties panel posts the whole bag it was displaying, which still
    holds the source type's fields. They must not survive the re-type."""
    session_id = _generated_session(test_client, sample_dir)
    unit = _units(test_client, session_id)[0]

    response = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "geofence", "properties": dict(unit["properties"])},
    )

    assert response.status_code == 200
    properties = response.json()["properties"]
    assert properties["category"] == "geofence"
    assert "level_id" not in properties
    assert "accessibility" not in properties
    assert properties["level_ids"] == [unit["properties"]["level_id"]]


@pytest.mark.phase4
def test_patch_rejects_a_type_the_geometry_cannot_hold(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = _units(test_client, session_id)[0]

    response = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "detail"},
    )
    assert response.status_code == 400
    assert "line" in response.json()["detail"]

    unknown = test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "not_an_imdf_type"},
    )
    assert unknown.status_code == 400

    # A rejected re-type leaves the feature untouched.
    assert test_client.get(f"/api/session/{session_id}/features/{unit['id']}").json()["feature_type"] == "unit"


@pytest.mark.phase4
def test_bulk_patch_retypes_a_whole_selection(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit_ids = [item["id"] for item in _units(test_client, session_id)]
    assert len(unit_ids) >= 2

    response = test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": unit_ids, "action": "patch", "feature_type": "geofence"},
    )

    assert response.status_code == 200
    assert response.json()["updated_count"] == len(unit_ids)

    features = test_client.get(f"/api/session/{session_id}/features").json()["features"]
    by_id = {item["id"]: item for item in features}
    assert all(by_id[feature_id]["feature_type"] == "geofence" for feature_id in unit_ids)


@pytest.mark.phase5
def test_retyped_features_export_into_the_target_geojson(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    units_before = _units(test_client, session_id)
    assert len(units_before) >= 2
    unit_ids = [units_before[0]["id"]]

    assert test_client.patch(
        f"/api/session/{session_id}/features/bulk",
        json={"feature_ids": unit_ids, "action": "patch", "feature_type": "geofence"},
    ).status_code == 200

    export = test_client.get(f"/api/session/{session_id}/export")
    assert export.status_code == 200
    with zipfile.ZipFile(BytesIO(export.content)) as archive:
        geofences = json.loads(archive.read("geofence.geojson"))["features"]
        units = json.loads(archive.read("unit.geojson"))["features"]

    assert {item["id"] for item in geofences} == set(unit_ids)
    assert not set(unit_ids) & {item["id"] for item in units}
    # Review-only bookkeeping is stripped on export exactly as for any other type.
    assert all("status" not in item["properties"] for item in geofences)


@pytest.mark.phase5
def test_retyped_geofence_passes_validation(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    unit = _units(test_client, session_id)[0]

    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"feature_type": "geofence"},
    ).status_code == 200

    validation = test_client.post(f"/api/session/{session_id}/validate").json()
    own_errors = [item for item in validation["errors"] if item.get("feature_id") == unit["id"]]
    assert own_errors == []
