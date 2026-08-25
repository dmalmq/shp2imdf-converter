"""Adding further source data to a session that already holds an IMDF dataset."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import json
import tempfile
import zipfile

import geopandas as gpd
import pytest
from shapely.geometry import Point, Polygon

from backend.tests.test_api import (
    _odc_id,
    _upload_all_shapefiles,
    _upload_payload,
    _write_imdf_schema_shapefiles,
)


# The host fixture (_write_imdf_schema_shapefiles) writes Demo 1F: a Site, a
# Building, a Floor named "First Floor"/"1F", and one Space on it.
HOST_LEVEL_NAME = "First Floor"


def _square(x: float, y: float, size: float = 0.0002) -> Polygon:
    return Polygon([(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)])


def _write_space_layer(
    root: Path,
    *,
    stem: str,
    unit_ids: list[str],
    geometries: list[Polygon],
    floor_id: str | None = None,
) -> None:
    gpd.GeoDataFrame(
        {
            "id": unit_ids,
            "category": ["B001"] * len(unit_ids),
            "floor_id": [floor_id] * len(unit_ids),
            "name": [f"Added {index}" for index in range(len(unit_ids))],
            "restricted": [None] * len(unit_ids),
            "suite": [None] * len(unit_ids),
            "nonpublic": [None] * len(unit_ids),
            "toll": [None] * len(unit_ids),
            "source": ["1"] * len(unit_ids),
        },
        geometry=geometries,
        crs="EPSG:4326",
    ).to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)


def _write_floor_layer(
    root: Path,
    *,
    stem: str,
    level_id: str,
    name: str,
    short_name: str,
    ordinal: float,
    geometry: Polygon,
) -> None:
    gpd.GeoDataFrame(
        {
            "id": [level_id],
            "category": ["1"],
            "name": [name],
            "ordinal": [ordinal],
            "short_name": [short_name],
            "source": ["1"],
        },
        geometry=[geometry],
        crs="EPSG:4326",
    ).to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)


def _start_session(test_client, root: Path) -> tuple[str, dict[str, str]]:
    ids = _write_imdf_schema_shapefiles(root)
    response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(root))
    assert response.status_code == 201
    return response.json()["session_id"], ids


def _stage(test_client, session_id: str, root: Path, **params) -> dict:
    response = test_client.post(
        f"/api/session/{session_id}/import/stage",
        files=_upload_all_shapefiles(root),
        params=params,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _commit(test_client, session_id: str, payload: dict) -> tuple[int, dict]:
    response = test_client.post(f"/api/session/{session_id}/import/commit", json=payload)
    return response.status_code, response.json()


def _features(test_client, session_id: str) -> list[dict]:
    return test_client.get(f"/api/session/{session_id}/features").json()["features"]


def _session(test_client, session_id: str):
    return test_client.app.state.session_manager.get_session(session_id, touch=False)


@pytest.mark.phase5
def test_staging_describes_the_batch_without_touching_the_session(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        before = _features(test_client, session_id)

        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-555555555551"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)

    assert plan["profile"] == "imdf_shapefile"
    assert [item["stem"] for item in plan["files"]] == ["Demo_1F_Fixture"]
    # No Floor layer in the batch, so the importer synthesises one from the
    # filename and it lines up with the session's 1F by floor label.
    assert len(plan["levels"]) == 1
    assert plan["levels"][0]["match_basis"] == "floor_label"
    assert plan["levels"][0]["host_level_id"] is not None
    assert plan["needs_decisions"] is False
    assert plan["id_collisions"] == 0
    assert [item["name"] for item in plan["host_levels"]] == [HOST_LEVEL_NAME]
    # Every unit here came from an uploaded row, so the source-linkage warning
    # must stay quiet rather than firing on every ordinary append.
    assert plan["warnings"] == []

    assert _features(test_client, session_id) == before
    assert _session(test_client, session_id).append_batches == []


@pytest.mark.phase5
def test_append_binds_new_features_to_the_existing_level(test_client) -> None:
    added_id = "55555555-5555-4555-8555-555555555552"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=[added_id],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})

    assert status == 200, result
    assert result["added_features"] >= 1
    assert list(result["bound_levels"].values()) == [ids["level_id"]]
    assert result["created_level_ids"] == []

    features = _features(test_client, session_id)
    levels = [item for item in features if item["feature_type"] == "level"]
    assert len(levels) == 1, "the batch's own level must merge into the session's"
    assert levels[0]["id"] == ids["level_id"]

    added = next(item for item in features if item["id"] == added_id)
    assert added["properties"]["level_id"] == ids["level_id"]
    assert added["properties"]["import_batch_id"] == plan["batch_id"]

    # The session's core features stay single.
    for feature_type in ("venue", "building", "address", "footprint"):
        assert len([item for item in features if item["feature_type"] == feature_type]) == 1

    session = _session(test_client, session_id)
    assert session.validation is None
    assert [item.batch_id for item in session.append_batches] == [plan["batch_id"]]


@pytest.mark.phase5
def test_a_floor_the_session_does_not_have_needs_an_explicit_decision(test_client) -> None:
    new_level_id = "66666666-6666-4666-8666-666666666661"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_floor_layer(
            add_root,
            stem="Demo_2F_Floor",
            level_id=new_level_id,
            name="Second Floor",
            short_name="2F",
            ordinal=1.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_space_layer(
            add_root,
            stem="Demo_2F_Space",
            unit_ids=["66666666-6666-4666-8666-666666666662"],
            geometries=[_square(139.7002, 35.6902)],
            floor_id=new_level_id,
        )
        plan = _stage(test_client, session_id, add_root)
        assert plan["needs_decisions"] is True
        assert plan["levels"][0]["match_basis"] == "unmatched"

        blocked_status, blocked = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
        assert blocked_status == 400
        assert "Second Floor" in blocked["detail"]

        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [{"candidate_level_id": new_level_id, "action": "create"}],
            },
        )

    assert status == 200, result
    assert result["created_level_ids"] == [new_level_id]

    features = _features(test_client, session_id)
    levels = {item["id"]: item for item in features if item["feature_type"] == "level"}
    assert set(levels) == {ids["level_id"], new_level_id}
    assert levels[new_level_id]["properties"]["building_ids"] == [ids["building_id"]]

    unit = next(item for item in features if item["id"] == "66666666-6666-4666-8666-666666666662")
    assert unit["properties"]["level_id"] == new_level_id


@pytest.mark.phase5
def test_a_rejected_level_leaves_its_features_out(test_client) -> None:
    new_level_id = "66666666-6666-4666-8666-666666666663"
    unit_id = "66666666-6666-4666-8666-666666666664"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_floor_layer(
            add_root,
            stem="Demo_2F_Floor",
            level_id=new_level_id,
            name="Second Floor",
            short_name="2F",
            ordinal=1.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_space_layer(
            add_root,
            stem="Demo_2F_Space",
            unit_ids=[unit_id],
            geometries=[_square(139.7002, 35.6902)],
            floor_id=new_level_id,
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [{"candidate_level_id": new_level_id, "action": "reject"}],
            },
        )

    assert status == 200, result
    assert result["rejected_level_ids"] == [new_level_id]
    assert result["added_features"] == 0

    ids_present = {item["id"] for item in _features(test_client, session_id)}
    assert new_level_id not in ids_present
    assert unit_id not in ids_present
    assert ids["level_id"] in ids_present


@pytest.mark.phase5
def test_a_level_matching_several_of_the_sessions_levels_is_ambiguous(test_client) -> None:
    """One floor holding several levels is normal, so "2F" alone cannot bind."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        host_root = Path(host_dir)
        _write_imdf_schema_shapefiles(host_root)
        # A second and third level that share the 2F label, as a real station does.
        for index, (level_id, name) in enumerate(
            (
                ("77777777-7777-4777-8777-777777777771", "Inside Gates"),
                ("77777777-7777-4777-8777-777777777772", "Outside Gates"),
            )
        ):
            _write_floor_layer(
                host_root,
                stem=f"Demo_2F_Part{index}_Floor",
                level_id=level_id,
                name=name,
                short_name="2F",
                ordinal=1.0,
                geometry=_square(139.7001 + index * 0.0009, 35.6901, size=0.0008),
            )
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(host_root))
        assert response.status_code == 201
        session_id = response.json()["session_id"]

        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_2F_Segment",
            unit_ids=["88888888-8888-4888-8888-888888888881"],
            geometries=[_square(139.7002, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        assert plan["needs_decisions"] is True
        match = plan["levels"][0]
        assert match["match_basis"] == "ambiguous"
        assert match["host_level_id"] is None
        assert len(match["host_level_options"]) == 2

        chosen = match["host_level_options"][1]["id"]
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [
                    {
                        "candidate_level_id": match["candidate_level_id"],
                        "action": "bind",
                        "host_level_id": chosen,
                    }
                ],
            },
        )

    assert status == 200, result
    unit = next(
        item
        for item in _features(test_client, session_id)
        if item["id"] == "88888888-8888-4888-8888-888888888881"
    )
    assert unit["properties"]["level_id"] == chosen


@pytest.mark.phase5
def test_a_colliding_id_is_reminted_by_default(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        # Same id as the unit the session already holds.
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=[ids["unit_id"]],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        assert plan["id_collisions"] == 1
        assert plan["id_collision_sample"] == [ids["unit_id"]]

        status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})

    assert status == 200, result
    assert result["reminted_ids"] == 1
    assert result["replaced_ids"] == 0

    features = _features(test_client, session_id)
    # Reminting keeps both: the session's unit under its own id, and the added
    # feature under a fresh one.
    assert ids["unit_id"] in {item["id"] for item in features if item["feature_type"] == "unit"}
    added = [item for item in features if item["properties"].get("import_batch_id") == plan["batch_id"]]
    assert len(added) == 1
    assert added[0]["id"] != ids["unit_id"]


@pytest.mark.phase5
def test_a_colliding_id_is_replaced_when_asked(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=[ids["unit_id"]],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {"batch_id": plan["batch_id"], "on_id_collision": "replace"},
        )

    assert status == 200, result
    assert result["replaced_ids"] == 1
    assert result["reminted_ids"] == 0

    holders = [item for item in _features(test_client, session_id) if item["id"] == ids["unit_id"]]
    assert len(holders) == 1
    assert holders[0]["properties"]["import_batch_id"] == plan["batch_id"]
    assert holders[0]["feature_type"] == "fixture", "the replacement takes the id over"


@pytest.mark.phase5
def test_a_layer_name_already_in_the_session_is_refused(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Space",
            unit_ids=["99999999-9999-4999-8999-999999999991"],
            geometries=[_square(139.7006, 35.6902)],
        )
        response = test_client.post(
            f"/api/session/{session_id}/import/stage",
            files=_upload_all_shapefiles(add_root),
        )

    assert response.status_code == 400
    assert "Demo_1F_Space" in response.json()["detail"]


@pytest.mark.phase5
def test_edits_made_before_an_append_survive_it(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        edited = test_client.patch(
            f"/api/session/{session_id}/features/{ids['unit_id']}",
            json={"properties": {"name": {"en": "Hand edited"}}},
        )
        assert edited.status_code == 200

        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-555555555553"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})

    assert status == 200, result
    unit = next(item for item in _features(test_client, session_id) if item["id"] == ids["unit_id"])
    assert unit["properties"]["name"] == {"en": "Hand edited"}


@pytest.mark.phase5
def test_appended_features_keep_the_linkage_the_shapefile_exports_need(test_client) -> None:
    added_id = "55555555-5555-4555-8555-555555555554"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=[added_id],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
        assert status == 200, result

    added = next(item for item in _features(test_client, session_id) if item["id"] == added_id)
    assert added["properties"]["source_file"] == "Demo_1F_Fixture"
    assert isinstance(added["properties"]["source_row_index"], int)

    session = _session(test_client, session_id)
    assert "Demo_1F_Fixture" in {item.stem for item in session.files}
    source_stems = {
        (row.get("properties") or {}).get("source_file")
        for row in session.source_feature_collection["features"]
    }
    assert "Demo_1F_Fixture" in source_stems
    # The uploaded shapefile has to sit beside the session's own, because the
    # roundtrip and ODC exports rewrite rows in the files on disk.
    artifact_stems = {path.stem for path in Path(session.upload_artifact_dir).glob("*.shp")}
    assert "Demo_1F_Fixture" in artifact_stems


@pytest.mark.phase5
def test_a_batch_cannot_be_committed_twice(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-555555555555"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        first, _ = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
        second, body = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})

    assert first == 200
    assert second == 400
    assert "already" in body["detail"]


@pytest.mark.phase5
def test_undo_puts_the_session_back(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        before_features = len(_features(test_client, session_id))
        before_session = _session(test_client, session_id)
        before_rows = len(before_session.source_feature_collection["features"])
        before_files = {item.stem for item in before_session.files}

        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-555555555556"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, _ = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
        assert status == 200
        assert len(_features(test_client, session_id)) > before_features

        undo = test_client.delete(f"/api/session/{session_id}/import/batches/{plan['batch_id']}")

    assert undo.status_code == 200, undo.text
    assert undo.json()["total_features"] == before_features

    session = _session(test_client, session_id)
    assert len(session.source_feature_collection["features"]) == before_rows
    assert {item.stem for item in session.files} == before_files
    assert session.append_batches == []
    assert ids["unit_id"] in {item["id"] for item in _features(test_client, session_id)}
    artifact_stems = {path.stem for path in Path(session.upload_artifact_dir).glob("*.shp")}
    assert "Demo_1F_Fixture" not in artifact_stems
    assert "Demo_1F_Space" in artifact_stems, "undo must not touch the session's own files"


@pytest.mark.phase5
def test_undo_restores_a_feature_that_was_replaced(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        original = next(
            item for item in _features(test_client, session_id) if item["id"] == ids["unit_id"]
        )
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=[ids["unit_id"]],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {"batch_id": plan["batch_id"], "on_id_collision": "replace"},
        )
        assert status == 200, result
        assert result["replaced_ids"] == 1

        undo = test_client.delete(f"/api/session/{session_id}/import/batches/{plan['batch_id']}")

    assert undo.status_code == 200, undo.text
    restored = next(item for item in _features(test_client, session_id) if item["id"] == ids["unit_id"])
    assert restored == original


@pytest.mark.phase5
def test_validation_catches_a_binding_that_contradicts_the_filename(test_client) -> None:
    """The rebind trusts the caller, so the level cross-check is the safety net."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        host_root = Path(host_dir)
        ids = _write_imdf_schema_shapefiles(host_root)
        _write_floor_layer(
            host_root,
            stem="Demo_B2_Floor",
            level_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            name="Basement Two",
            short_name="B2F",
            ordinal=-2.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        response = test_client.post("/api/import/imdf-shapefiles", files=_upload_all_shapefiles(host_root))
        assert response.status_code == 201
        session_id = response.json()["session_id"]

        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_B2_Space",
            unit_ids=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"],
            geometries=[_square(139.7002, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        # The batch would bind to B2 on its own; override it onto 1F instead.
        assert plan["levels"][0]["match_basis"] == "floor_label"
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [
                    {
                        "candidate_level_id": plan["levels"][0]["candidate_level_id"],
                        "action": "bind",
                        "host_level_id": ids["level_id"],
                    }
                ],
            },
        )
        assert status == 200, result

        validation = test_client.post(f"/api/session/{session_id}/validate").json()

    assert "orphaned_reference_error" not in {issue["check"] for issue in validation["errors"]}
    mismatches = [issue for issue in validation["warnings"] if issue["check"] == "level_floor_mismatch"]
    assert mismatches, [issue["check"] for issue in validation["warnings"]]
    assert mismatches[0]["related_feature_id"] == ids["level_id"]


# ---------------------------------------------------------------------------
# The standard profile: arbitrary source layers that need attribute mapping
# ---------------------------------------------------------------------------


PROJECT = {
    "project_name": "Tokyo Station",
    "venue_name": "Tokyo Station",
    "venue_category": "transitstation",
    "language": "en",
    "address": {"address": "1-9-1 Marunouchi", "locality": "Chiyoda-ku", "country": "JP"},
}
UNIT_MAPPING = {
    "unit": {"code_column": "COMPANY_CO", "name_column": "NAME"},
    "unit_category_overrides": {"SHOP": "retail", "FOOD": "storage", "OFFICE": "office"},
}


def _start_standard_session(test_client, sample_dir: Path, *, mappings: dict | None = UNIT_MAPPING) -> str:
    """Import one floor the ordinary way: upload, wizard, generate."""
    response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    assert response.status_code == 201
    session_id = response.json()["session_id"]
    assert test_client.patch(f"/api/session/{session_id}/wizard/project", json=PROJECT).status_code == 200
    if mappings is not None:
        assert test_client.patch(f"/api/session/{session_id}/wizard/mappings", json=mappings).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    return session_id


def _stage_from_fixture(test_client, session_id: str, sample_dir: Path, stem: str) -> dict:
    response = test_client.post(
        f"/api/session/{session_id}/import/stage",
        files=_upload_payload(sample_dir, stem),
        params={"profile": "standard"},
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.phase5
def test_standard_append_binds_to_the_level_the_session_already_has(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir)
    before_levels = [item for item in _features(test_client, session_id) if item["feature_type"] == "level"]
    assert len(before_levels) == 1

    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_B1_Opening")
    assert plan["profile"] == "standard"
    assert plan["levels"][0]["match_basis"] == "name"
    assert plan["needs_decisions"] is False

    status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
    assert status == 200, result

    features = _features(test_client, session_id)
    assert len([item for item in features if item["feature_type"] == "level"]) == 1
    opening = next(item for item in features if item["feature_type"] == "opening")
    assert opening["properties"]["level_id"] == before_levels[0]["id"]
    assert opening["properties"]["import_batch_id"] == plan["batch_id"]
    # The generator is the source of this linkage; without it the shapefile
    # exports drop the feature.
    assert opening["properties"]["source_file"] == "JRTokyoSta_B1_Opening"
    assert isinstance(opening["properties"]["source_row_index"], int)


@pytest.mark.phase5
def test_standard_append_can_add_a_floor_the_session_does_not_have(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir)
    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_GF_Space")
    assert plan["levels"][0]["match_basis"] == "unmatched"
    assert plan["levels"][0]["ordinal"] == 0

    candidate_level_id = plan["levels"][0]["candidate_level_id"]
    status, result = _commit(
        test_client,
        session_id,
        {
            "batch_id": plan["batch_id"],
            "level_decisions": [{"candidate_level_id": candidate_level_id, "action": "create"}],
        },
    )
    assert status == 200, result

    features = _features(test_client, session_id)
    levels = {item["properties"]["ordinal"]: item for item in features if item["feature_type"] == "level"}
    assert set(levels) == {-1, 0}
    building_ids = [item["id"] for item in features if item["feature_type"] == "building"]
    assert len(building_ids) == 1
    assert levels[0]["properties"]["building_ids"] == building_ids


@pytest.mark.phase5
def test_the_sessions_mapping_choices_apply_to_what_is_added(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir)
    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_GF_Space")
    assert plan["needs_mapping"] is False
    assert plan["mappings"]["unit"]["code_column"] == "COMPANY_CO"

    status, result = _commit(
        test_client,
        session_id,
        {
            "batch_id": plan["batch_id"],
            "level_decisions": [
                {"candidate_level_id": plan["levels"][0]["candidate_level_id"], "action": "create"}
            ],
        },
    )
    assert status == 200, result

    added = next(
        item
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"] and item["feature_type"] == "unit"
    )
    # COMPANY_CO "OFFICE" resolved through the session's own company mappings.
    assert added["properties"]["category"] == "office"
    assert added["properties"]["name"] == {"en": "GF Room A"}


@pytest.mark.phase5
def test_a_session_with_no_mapping_yet_says_so(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir, mappings=None)
    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_GF_Space")
    assert plan["needs_mapping"] is True

    # An opening layer carries no unit codes, so nothing is waiting on a choice.
    opening_plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_B1_Opening")
    assert opening_plan["needs_mapping"] is False


@pytest.mark.phase5
def test_restaging_remaps_the_batch_and_leaves_the_session_alone(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir)
    host_categories_before = {
        item["id"]: item["properties"]["category"]
        for item in _features(test_client, session_id)
        if item["feature_type"] == "unit"
    }
    assert set(host_categories_before.values()) == {"retail", "storage"}

    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_GF_Space")
    restaged = test_client.patch(
        f"/api/session/{session_id}/import/stage/{plan['batch_id']}",
        json={"mappings": {"unit": {"code_column": "NAME"}}},
    )
    assert restaged.status_code == 200, restaged.text
    new_plan = restaged.json()
    assert new_plan["mappings"]["unit"]["code_column"] == "NAME"

    status, result = _commit(
        test_client,
        session_id,
        {
            "batch_id": plan["batch_id"],
            "level_decisions": [
                {"candidate_level_id": new_plan["levels"][0]["candidate_level_id"], "action": "create"}
            ],
        },
    )
    assert status == 200, result

    features = _features(test_client, session_id)
    added = next(
        item
        for item in features
        if item["properties"].get("import_batch_id") == plan["batch_id"] and item["feature_type"] == "unit"
    )
    # "GF Room A" is not a category, so the added unit falls back instead of
    # resolving through COMPANY_CO.
    assert added["properties"]["category"] != "office"
    assert added["properties"]["name"] is None

    host_categories_after = {
        item["id"]: item["properties"]["category"]
        for item in features
        if item["feature_type"] == "unit" and item["id"] in host_categories_before
    }
    assert host_categories_after == host_categories_before

    session = _session(test_client, session_id)
    assert session.wizard.mappings.unit.code_column == "COMPANY_CO", "the batch's mapping is not the session's"


@pytest.mark.phase5
def test_restaging_can_move_a_batch_onto_another_floor(test_client, sample_dir: Path) -> None:
    session_id = _start_standard_session(test_client, sample_dir)
    host_level_id = next(
        item["id"] for item in _features(test_client, session_id) if item["feature_type"] == "level"
    )

    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_GF_Space")
    assert plan["levels"][0]["match_basis"] == "unmatched"

    restaged = test_client.patch(
        f"/api/session/{session_id}/import/stage/{plan['batch_id']}",
        json={"files": [{"stem": "JRTokyoSta_GF_Space", "detected_level": -1}]},
    )
    assert restaged.status_code == 200, restaged.text
    new_plan = restaged.json()
    assert new_plan["levels"][0]["match_basis"] == "name"
    assert new_plan["levels"][0]["host_level_id"] == host_level_id
    assert new_plan["needs_decisions"] is False

    status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
    assert status == 200, result

    features = _features(test_client, session_id)
    assert len([item for item in features if item["feature_type"] == "level"]) == 1
    added = next(item for item in features if item["properties"].get("import_batch_id") == plan["batch_id"])
    assert added["properties"]["level_id"] == host_level_id
    session = _session(test_client, session_id)
    assert next(item.detected_level for item in session.files if item.stem == "JRTokyoSta_GF_Space") == -1


@pytest.mark.phase5
def test_a_standard_append_does_not_regenerate_the_host(test_client, sample_dir: Path) -> None:
    """Regeneration is how the standard profile normally applies changes, and it
    would discard every review-screen edit. The append must not trigger one."""
    session_id = _start_standard_session(test_client, sample_dir)
    features = _features(test_client, session_id)
    target = next(item for item in features if item["feature_type"] == "unit")
    edited = test_client.patch(
        f"/api/session/{session_id}/features/{target['id']}",
        json={"properties": {"name": {"en": "Hand edited"}, "category": "nonpublic"}},
    )
    assert edited.status_code == 200

    plan = _stage_from_fixture(test_client, session_id, sample_dir, "JRTokyoSta_B1_Opening")
    status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
    assert status == 200, result

    after = next(item for item in _features(test_client, session_id) if item["id"] == target["id"])
    assert after["properties"]["name"] == {"en": "Hand edited"}
    assert after["properties"]["category"] == "nonpublic"


@pytest.mark.phase5
def test_only_the_standard_profile_can_be_restaged(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-555555555557"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        response = test_client.patch(
            f"/api/session/{session_id}/import/stage/{plan['batch_id']}",
            json={"mappings": {"unit": {"code_column": "NAME"}}},
        )

    assert response.status_code == 400
    assert "standard profile" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Exporting a session that has had data added to it
# ---------------------------------------------------------------------------


def _write_unit_layer(
    root: Path,
    *,
    stem: str,
    unit_ids: list[str],
    geometries: list[Polygon],
    floor_id: str | None = None,
    category: str = "B002",
) -> None:
    count = len(unit_ids)
    gpd.GeoDataFrame(
        {
            "id": unit_ids,
            "category": [category] * count,
            "floor_id": [floor_id] * count,
            "name": [f"Added room {index}" for index in range(count)],
            "restricted": [None] * count,
            "suite": [None] * count,
            "nonpublic": [None] * count,
            "toll": [None] * count,
            "source": ["1"] * count,
        },
        geometry=geometries,
        crs="EPSG:4326",
    ).to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)


def _append_a_unit_layer(test_client, session_id: str, root: Path, stem: str, unit_ids: list[str]) -> dict:
    """Stage and commit one extra Space layer onto the session's existing floor."""
    _write_unit_layer(
        root,
        stem=stem,
        unit_ids=unit_ids,
        geometries=[_square(139.7005 + index * 0.0003, 35.6905) for index in range(len(unit_ids))],
    )
    plan = _stage(test_client, session_id, root)
    status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})
    assert status == 200, result
    return plan


@pytest.mark.phase5
def test_imdf_export_carries_the_added_features(test_client) -> None:
    added = ["ee000000-0000-4000-8000-000000000001", "ee000000-0000-4000-8000-000000000002"]
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        _append_a_unit_layer(test_client, session_id, Path(add_dir), "Demo_1F_Extra_Space", added)

    response = test_client.get(f"/api/session/{session_id}/export")
    assert response.status_code == 200

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        unit_name = next(name for name in archive.namelist() if name.endswith("unit.geojson"))
        units = json.loads(archive.read(unit_name))
        level_name = next(name for name in archive.namelist() if name.endswith("level.geojson"))
        levels = json.loads(archive.read(level_name))

    unit_ids = {feature["id"] for feature in units["features"]}
    assert set(added).issubset(unit_ids)
    assert ids["unit_id"] in unit_ids
    # The batch's own level merged into the session's rather than joining it.
    assert len(levels["features"]) == 1
    assert {feature["properties"]["level_id"] for feature in units["features"]} == {ids["level_id"]}


@pytest.mark.phase5
def test_roundtrip_shapefile_export_writes_the_added_layer_back(test_client) -> None:
    added = ["ee000000-0000-4000-8000-000000000003", "ee000000-0000-4000-8000-000000000004"]
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        _append_a_unit_layer(test_client, session_id, Path(add_dir), "Demo_1F_Extra_Space", added)

    response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "imdf_roundtrip"},
    )
    assert response.status_code == 200, response.text

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        report = json.loads(archive.read("export_report.json"))

    # The added layer is exported alongside the session's own, under the name
    # the roundtrip profile gives a unit layer.
    assert "Demo_1F_Extra_unit.shp" in names
    assert "Demo_1F_unit.shp" in names
    # Nothing was dropped: every unit still traces back to an uploaded row.
    assert report["unapplied_features"] == []
    assert report["rows_requested"] == 3


@pytest.mark.phase5
def test_odc_export_merges_added_rooms_into_the_floors_own_file(test_client) -> None:
    """One ODC file per floor, so an added layer joins the floor's Space file."""
    added = ["ee000000-0000-4000-8000-000000000005", "ee000000-0000-4000-8000-000000000006"]
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        _append_a_unit_layer(test_client, session_id, Path(add_dir), "Demo_1F_Extra_Space", added)

    response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert response.status_code == 200, response.text

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")

    assert report["rows_skipped"] == []
    assert len(space) == 3, "the added rooms join the floor's file instead of overwriting it"
    assert sorted(space["category"].tolist()) == ["B001", "B002", "B002"]
    assert set(space["floor_id"].tolist()) == {_odc_id(ids["level_id"])}


@pytest.mark.phase5
def test_a_floor_added_by_an_append_gets_its_own_odc_files(test_client) -> None:
    new_level_id = "66666666-6666-4666-8666-666666666671"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_floor_layer(
            add_root,
            stem="Demo_2F_Floor",
            level_id=new_level_id,
            name="Second Floor",
            short_name="2F",
            ordinal=1.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_unit_layer(
            add_root,
            stem="Demo_2F_Space",
            unit_ids=["77777777-7777-4777-8777-777777777771"],
            geometries=[_square(139.7002, 35.6902)],
            floor_id=new_level_id,
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [{"candidate_level_id": new_level_id, "action": "create"}],
            },
        )
        assert status == 200, result

    response = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "odc2026", "export_name": "Demo_Station"},
    )
    assert response.status_code == 200, response.text

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        project = archive.read("Demo_Station_qgis.qgs").decode("utf-8")

    assert {"Demo_Station_2_Floor.shp", "Demo_Station_2_Space.shp"}.issubset(names)
    assert {"Demo_Station_1_Floor.shp", "Demo_Station_1_Space.shp"}.issubset(names)
    # A layer the project cannot order or style is silently omitted, so the
    # added floor has to be named in the project as well as written to disk.
    for layer in ("Demo_Station_1_Space", "Demo_Station_2_Space", "Demo_Station_2_Floor"):
        assert layer in project

    validation = test_client.post(f"/api/session/{session_id}/validate").json()
    assert validation["errors"] == []


@pytest.mark.phase5
def test_qgis_project_export_still_builds_after_an_append(test_client) -> None:
    added = ["ee000000-0000-4000-8000-000000000007"]
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        _append_a_unit_layer(test_client, session_id, Path(add_dir), "Demo_1F_Extra_Space", added)

    response = test_client.post(
        f"/api/session/{session_id}/export/qgis",
        json={"export_name": "Demo_Station"},
    )
    if response.status_code == 503:
        pytest.skip("QGIS is not available on this machine")
    assert response.status_code == 200, response.text

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        names = set(archive.namelist())
    assert any(name.endswith(".qgz") for name in names)
    assert "Demo_Station_1_Space.shp" in names


@pytest.mark.phase5
def test_undoing_an_append_restores_what_the_exports_produce(test_client) -> None:
    added = ["ee000000-0000-4000-8000-000000000008"]
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        odc_request = {"profile": "odc2026", "export_name": "Demo_Station"}
        before = test_client.post(f"/api/session/{session_id}/export/shapefiles", json=odc_request)
        with zipfile.ZipFile(BytesIO(before.content)) as archive:
            names_before = {name for name in archive.namelist() if name.endswith(".shp")}

        plan = _append_a_unit_layer(test_client, session_id, Path(add_dir), "Demo_1F_Extra_Space", added)
        undo = test_client.delete(f"/api/session/{session_id}/import/batches/{plan['batch_id']}")
        assert undo.status_code == 200, undo.text

        after = test_client.post(f"/api/session/{session_id}/export/shapefiles", json=odc_request)

    assert after.status_code == 200, after.text
    with zipfile.ZipFile(BytesIO(after.content)) as archive:
        with tempfile.TemporaryDirectory() as output_dir:
            archive.extractall(output_dir)
            space = gpd.read_file(Path(output_dir) / "Demo_Station_1_Space.shp")
        assert {name for name in archive.namelist() if name.endswith(".shp")} == names_before
    assert len(space) == 1
    assert set(space["id"]).isdisjoint({_odc_id(item) for item in added})

    # The roundtrip export writes back into the uploaded files, so undo has to
    # have taken the added shapefile out of the artifact directory too.
    roundtrip = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "imdf_roundtrip"},
    )
    assert roundtrip.status_code == 200, roundtrip.text
    with zipfile.ZipFile(BytesIO(roundtrip.content)) as archive:
        assert not any(name.startswith("Demo_1F_Extra") for name in archive.namelist())


@pytest.mark.phase5
def test_adding_to_an_imdf_archive_session_warns_that_shapefile_export_is_partial(test_client) -> None:
    """A session opened from an IMDF zip has no source rows behind its features.

    Adding one layer satisfies the roundtrip export's "are the sources here?"
    check, so it stops refusing and starts producing an archive holding only
    the added layer. That is worth saying before the append, not after the
    download, so the preview says it.
    """
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        archive_bytes = test_client.get(f"/api/session/{session_id}/export").content
        opened = test_client.post(
            "/api/import/imdf",
            files={"file": ("demo.zip", archive_bytes, "application/zip")},
        )
        assert opened.status_code == 201
        imdf_session = opened.json()["session_id"]

        refused = test_client.post(
            f"/api/session/{imdf_session}/export/shapefiles",
            json={"profile": "imdf_roundtrip"},
        )
        assert refused.status_code == 400
        assert "not available" in refused.json()["detail"]

        add_root = Path(add_dir)
        _write_unit_layer(
            add_root,
            stem="Demo_1F_Late_Space",
            unit_ids=["ee000000-0000-4000-8000-000000000009"],
            geometries=[_square(139.7006, 35.6906)],
        )
        plan = _stage(test_client, imdf_session, add_root)

    assert any("shapefile export" in warning for warning in plan["warnings"]), plan["warnings"]
    assert any("did not come from an uploaded shapefile" in warning for warning in plan["warnings"])

    status, result = _commit(test_client, imdf_session, {"batch_id": plan["batch_id"]})
    assert status == 200, result

    # IMDF export stays whole; it does not depend on the uploaded files.
    imdf = test_client.get(f"/api/session/{imdf_session}/export")
    assert imdf.status_code == 200
    with zipfile.ZipFile(BytesIO(imdf.content)) as archive:
        units = json.loads(archive.read(next(n for n in archive.namelist() if n.endswith("unit.geojson"))))
    assert len(units["features"]) == 2

    # The shapefile export now succeeds but covers only the added layer, and
    # says so in its report rather than passing the gap off as complete.
    partial = test_client.post(
        f"/api/session/{imdf_session}/export/shapefiles",
        json={"profile": "imdf_roundtrip"},
    )
    assert partial.status_code == 200
    with zipfile.ZipFile(BytesIO(partial.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
    assert [item["reason"] for item in report["unapplied_features"]] == ["missing_source_linkage"]


# ---------------------------------------------------------------------------
# Bringing in only part of a layer
# ---------------------------------------------------------------------------


def _write_mixed_unit_layer(root: Path, *, stem: str, rows: list[tuple[str, str, str]]) -> None:
    """rows: (id, category, name), laid out left to right so a box can split them."""
    gpd.GeoDataFrame(
        {
            "id": [row[0] for row in rows],
            "category": [row[1] for row in rows],
            "floor_id": [None] * len(rows),
            "name": [row[2] for row in rows],
            "restricted": [None] * len(rows),
            "suite": [None] * len(rows),
            "nonpublic": [None] * len(rows),
            "toll": [None] * len(rows),
            "source": ["1"] * len(rows),
        },
        geometry=[_square(139.7002 + index * 0.0004, 35.6902) for index in range(len(rows))],
        crs="EPSG:4326",
    ).to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)


MIXED_ROWS = [
    ("dd000000-0000-4000-8000-00000000000%d" % index, category, name)
    for index, (category, name) in enumerate(
        [("B001", "Shop A"), ("B001", "Shop B"), ("B019", "Store room"), ("B019", "Plant room")]
    )
]
MIXED_IDS = [row[0] for row in MIXED_ROWS]


def _stage_mixed(test_client, session_id: str, root: Path, stem: str = "Demo_1F_Extra_Space") -> dict:
    _write_mixed_unit_layer(root, stem=stem, rows=MIXED_ROWS)
    return _stage(test_client, session_id, root)


def _candidates(test_client, session_id: str, batch_id: str) -> dict:
    response = test_client.get(f"/api/session/{session_id}/import/stage/{batch_id}/features")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.phase5
def test_the_batchs_features_are_listed_for_choosing(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        payload = _candidates(test_client, session_id, plan["batch_id"])

    rows = {item["id"]: item for item in payload["features"]}
    assert set(MIXED_IDS).issubset(rows)
    # Levels are not offered: they carry the floor decisions, not content.
    assert all(item["feature_type"] != "level" for item in payload["features"])

    first = rows[MIXED_IDS[0]]
    assert first["feature_type"] == "unit"
    assert first["stem"] == "Demo_1F_Extra_Space"
    assert first["name"] == "Shop A"
    assert first["attributes"]["category"] == "B001"
    assert first["point"] is not None and len(first["point"]) == 2
    assert first["already_imported"] is False
    assert "category" in payload["columns_by_stem"]["Demo_1F_Extra_Space"]


@pytest.mark.phase5
def test_an_attribute_filter_brings_in_only_the_matching_rows(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {
                    "layers": [
                        {
                            "stem": "Demo_1F_Extra_Space",
                            "filter_column": "category",
                            "filter_values": ["B001"],
                        }
                    ]
                },
            },
        )

    assert status == 200, result
    assert result["added_features"] == 2
    assert result["deselected_features"] == 2

    added = {
        item["id"]
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    }
    assert added == set(MIXED_IDS[:2])


@pytest.mark.phase5
def test_individual_features_can_be_ticked_off_and_back_on(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {
                    # The filter would take both B001 rows; one is ticked off and
                    # a B019 row is ticked back on over the top of it.
                    "layers": [
                        {
                            "stem": "Demo_1F_Extra_Space",
                            "filter_column": "category",
                            "filter_values": ["B001"],
                        }
                    ],
                    "excluded_feature_ids": [MIXED_IDS[1]],
                    "included_feature_ids": [MIXED_IDS[3]],
                },
            },
        )

    assert status == 200, result
    added = {
        item["id"]
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    }
    assert added == {MIXED_IDS[0], MIXED_IDS[3]}


@pytest.mark.phase5
def test_a_box_keeps_only_what_falls_inside_it(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        # The rows sit at x = 139.7002, .7006, .7010, .7014; this box covers the
        # first two only.
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {"bbox": [139.7000, 35.6900, 139.7008, 35.6910]},
            },
        )

    assert status == 200, result
    added = {
        item["id"]
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    }
    assert added == set(MIXED_IDS[:2])


@pytest.mark.phase5
def test_selecting_by_feature_type_leaves_the_other_types_out(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_mixed_unit_layer(add_root, stem="Demo_1F_Extra_Space", rows=MIXED_ROWS)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Extra_Fixture",
            unit_ids=["cc000000-0000-4000-8000-000000000001"],
            geometries=[_square(139.7020, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {"batch_id": plan["batch_id"], "selection": {"feature_types": ["unit"]}},
        )

    assert status == 200, result
    added = [
        item
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    ]
    assert {item["feature_type"] for item in added} == {"unit"}
    assert len(added) == len(MIXED_IDS)


@pytest.mark.phase5
def test_only_the_rows_taken_in_are_recorded_as_imported(test_client) -> None:
    """The source rows say what came in, so a later pass can tell what is left."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, _ = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {
                    "layers": [
                        {"stem": "Demo_1F_Extra_Space", "filter_column": "category", "filter_values": ["B001"]}
                    ]
                },
            },
        )
        assert status == 200

    session = _session(test_client, session_id)
    rows = [
        row
        for row in session.source_feature_collection["features"]
        if (row.get("properties") or {}).get("source_file") == "Demo_1F_Extra_Space"
    ]
    assert len(rows) == 2


@pytest.mark.phase5
def test_the_same_layer_can_be_added_again_for_the_rows_left_out(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        first = _stage_mixed(test_client, session_id, add_root)
        status, _ = _commit(
            test_client,
            session_id,
            {
                "batch_id": first["batch_id"],
                "selection": {
                    "layers": [
                        {"stem": "Demo_1F_Extra_Space", "filter_column": "category", "filter_values": ["B001"]}
                    ]
                },
            },
        )
        assert status == 200

        # The very same file, uploaded again to collect what was left behind.
        second = _stage(test_client, session_id, add_root)
        candidates = _candidates(test_client, session_id, second["batch_id"])
        already = {item["id"] for item in candidates["features"] if item["already_imported"]}
        assert already == set(MIXED_IDS[:2])

        status, result = _commit(test_client, session_id, {"batch_id": second["batch_id"]})

    assert status == 200, result
    assert result["skipped_already_imported"] == 2
    assert result["added_features"] == 2

    features = _features(test_client, session_id)
    added_ids = [item["id"] for item in features if item["id"] in set(MIXED_IDS)]
    assert sorted(added_ids) == sorted(MIXED_IDS), "all four rows are in, none of them twice"

    session = _session(test_client, session_id)
    assert [item.stem for item in session.files].count("Demo_1F_Extra_Space") == 1


@pytest.mark.phase5
def test_a_different_file_may_not_take_a_layer_name_already_in_use(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        first = _stage_mixed(test_client, session_id, add_root)
        assert _commit(test_client, session_id, {"batch_id": first["batch_id"]})[0] == 200

        # Same layer name, different contents.
        _write_mixed_unit_layer(
            add_root,
            stem="Demo_1F_Extra_Space",
            rows=[("dd000000-0000-4000-8000-0000000000a1", "B001", "Something else")],
        )
        response = test_client.post(
            f"/api/session/{session_id}/import/stage",
            files=_upload_all_shapefiles(add_root),
        )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "Demo_1F_Extra_Space" in detail
    assert "same file" in detail


@pytest.mark.phase5
def test_undoing_a_second_pass_leaves_the_first_pass_alone(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        first = _stage_mixed(test_client, session_id, add_root)
        assert _commit(
            test_client,
            session_id,
            {
                "batch_id": first["batch_id"],
                "selection": {
                    "layers": [
                        {"stem": "Demo_1F_Extra_Space", "filter_column": "category", "filter_values": ["B001"]}
                    ]
                },
            },
        )[0] == 200

        second = _stage(test_client, session_id, add_root)
        assert _commit(test_client, session_id, {"batch_id": second["batch_id"]})[0] == 200

        undo = test_client.delete(f"/api/session/{session_id}/import/batches/{second['batch_id']}")

    assert undo.status_code == 200, undo.text
    present = {item["id"] for item in _features(test_client, session_id)}
    assert set(MIXED_IDS[:2]).issubset(present), "the first pass survives"
    assert present.isdisjoint(set(MIXED_IDS[2:]))

    session = _session(test_client, session_id)
    # The second pass added no new layer, so undo must not have removed the file
    # the first pass still writes back through.
    assert "Demo_1F_Extra_Space" in {item.stem for item in session.files}
    artifact_stems = {path.stem for path in Path(session.upload_artifact_dir).glob("*.shp")}
    assert "Demo_1F_Extra_Space" in artifact_stems

    roundtrip = test_client.post(
        f"/api/session/{session_id}/export/shapefiles",
        json={"profile": "imdf_roundtrip"},
    )
    assert roundtrip.status_code == 200, roundtrip.text
    with zipfile.ZipFile(BytesIO(roundtrip.content)) as archive:
        report = json.loads(archive.read("export_report.json"))
    assert report["unapplied_features"] == []


@pytest.mark.phase5
def test_a_new_floor_with_nothing_selected_is_not_created(test_client) -> None:
    new_level_id = "66666666-6666-4666-8666-666666666681"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_floor_layer(
            add_root,
            stem="Demo_2F_Floor",
            level_id=new_level_id,
            name="Second Floor",
            short_name="2F",
            ordinal=1.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_space_layer(
            add_root,
            stem="Demo_2F_Space",
            unit_ids=["66666666-6666-4666-8666-666666666682"],
            geometries=[_square(139.7002, 35.6902)],
            floor_id=new_level_id,
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "level_decisions": [{"candidate_level_id": new_level_id, "action": "create"}],
                "selection": {"feature_types": ["opening"]},
            },
        )

    assert status == 200, result
    assert result["created_level_ids"] == [], "an empty floor is not worth adding"
    levels = [item for item in _features(test_client, session_id) if item["feature_type"] == "level"]
    assert [item["id"] for item in levels] == [ids["level_id"]]


# ---------------------------------------------------------------------------
# Source geometry GEOS refuses to union
# ---------------------------------------------------------------------------


def _explode_first_union(monkeypatch) -> list[int]:
    """Make the first plain union raise the way real CAD geometry does.

    Which coordinates actually trip a side location conflict depends on the GEOS
    build, so the failure is injected. What is under test is that a generation
    survives one rather than returning a 500.
    """
    from shapely.errors import GEOSException

    from backend.src import generator as generator_module
    from backend.src import geometry as geometry_module

    calls: list[int] = []

    def always_conflicts(geoms):
        calls.append(1)
        raise GEOSException(
            "TopologyException: side location conflict at 139.73892534653464 35.634146823762464"
        )

    # Both names are poisoned on purpose. ``safe_union`` catches its own failure
    # and recovers by snapping; the generator's own ``unary_union`` has no such
    # guard, so if any union in the generation path still goes through it
    # directly, the exception escapes and the request 500s — which is exactly
    # the crash this is here to keep from coming back.
    monkeypatch.setattr(geometry_module, "unary_union", always_conflicts)
    monkeypatch.setattr(generator_module, "unary_union", always_conflicts)
    return calls


@pytest.mark.phase5
def test_the_ordinary_import_survives_geometry_geos_will_not_union(
    test_client, sample_dir: Path, monkeypatch
) -> None:
    response = test_client.post("/api/import", files=_upload_payload(sample_dir, "JRTokyoSta_B1_Space"))
    session_id = response.json()["session_id"]
    assert test_client.patch(f"/api/session/{session_id}/wizard/project", json=PROJECT).status_code == 200

    calls = _explode_first_union(monkeypatch)
    generated = test_client.post(f"/api/session/{session_id}/generate")

    assert calls, "the union under test was reached"
    assert generated.status_code == 200, generated.text
    assert any(item["feature_type"] == "level" for item in _features(test_client, session_id))


@pytest.mark.phase5
def test_an_append_survives_geometry_geos_will_not_union(
    test_client, sample_dir: Path, monkeypatch
) -> None:
    """The standard-profile append generates in a scratch session, so it hits
    the same union the wizard does and needs the same repair."""
    session_id = _start_standard_session(test_client, sample_dir)

    calls = _explode_first_union(monkeypatch)
    response = test_client.post(
        f"/api/session/{session_id}/import/stage",
        files=_upload_payload(sample_dir, "JRTokyoSta_GF_Space"),
        params={"profile": "standard"},
    )

    assert calls, "the union under test was reached"
    assert response.status_code == 201, response.text
    plan = response.json()
    assert plan["levels"], "a level was still built from the repaired union"

    status, result = _commit(
        test_client,
        session_id,
        {
            "batch_id": plan["batch_id"],
            "level_decisions": [
                {"candidate_level_id": plan["levels"][0]["candidate_level_id"], "action": "create"}
            ],
        },
    )
    assert status == 200, result
    assert result["added_features"] > 0


@pytest.mark.phase5
def test_picked_mode_brings_in_only_what_was_named(test_client) -> None:
    """The opposite starting point: nothing comes in until it is picked.

    The default takes everything the filters match and treats a click as
    removing one. For "just these few rooms" that is backwards, and committing
    it imports the whole batch except the ones you chose.
    """
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {
                    "base": "picked",
                    "included_feature_ids": [MIXED_IDS[0], MIXED_IDS[3]],
                },
            },
        )

    assert status == 200, result
    assert result["added_features"] == 2
    added = {
        item["id"]
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    }
    assert added == {MIXED_IDS[0], MIXED_IDS[3]}


@pytest.mark.phase5
def test_picked_mode_ignores_the_filters_when_deciding_what_comes_in(test_client) -> None:
    """Filters scope what *can* be picked; they never add anything by themselves."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {
                    "base": "picked",
                    # A filter that would match two rows, and one pick that is
                    # not among them: only the pick comes in.
                    "layers": [
                        {"stem": "Demo_1F_Extra_Space", "filter_column": "category", "filter_values": ["B001"]}
                    ],
                    "included_feature_ids": [MIXED_IDS[2]],
                },
            },
        )

    assert status == 200, result
    assert result["added_features"] == 1
    added = {
        item["id"]
        for item in _features(test_client, session_id)
        if item["properties"].get("import_batch_id") == plan["batch_id"]
    }
    assert added == {MIXED_IDS[2]}


@pytest.mark.phase5
def test_picked_mode_with_nothing_picked_adds_nothing(test_client) -> None:
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        plan = _stage_mixed(test_client, session_id, Path(add_dir))
        status, result = _commit(
            test_client,
            session_id,
            {"batch_id": plan["batch_id"], "selection": {"base": "picked"}},
        )

    assert status == 200, result
    assert result["added_features"] == 0
    assert result["created_level_ids"] == []


@pytest.mark.phase5
def test_a_floor_nothing_was_selected_from_needs_no_answer(test_client) -> None:
    """A batch spans every floor of a station; a pick touches one or two.

    Requiring a decision per floor in the batch meant answering about
    twenty-odd floors that were contributing nothing, and the commit refused
    until they were all answered.
    """
    new_level_id = "66666666-6666-4666-8666-666666666691"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        # A second floor that would otherwise demand an answer of its own.
        _write_floor_layer(
            add_root,
            stem="Demo_2F_Floor",
            level_id=new_level_id,
            name="Second Floor",
            short_name="2F",
            ordinal=1.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_space_layer(
            add_root,
            stem="Demo_2F_Space",
            unit_ids=["66666666-6666-4666-8666-666666666692"],
            geometries=[_square(139.7002, 35.6902)],
            floor_id=new_level_id,
        )
        # A 1F floor of its own: with any Floor layer present the importer stops
        # synthesising levels from filenames, so floorless rows would be dropped
        # before a selection ever saw them.
        _write_floor_layer(
            add_root,
            stem="Demo_1F_Floor",
            level_id=ids["level_id"],
            name="First Floor",
            short_name="1F",
            ordinal=0.0,
            geometry=_square(139.7001, 35.6901, size=0.0008),
        )
        _write_mixed_unit_layer(add_root, stem="Demo_1F_Extra_Space", rows=MIXED_ROWS)
        # The mixed rows carry no floor_id, so point them at the 1F level.
        import geopandas as _gpd
        _layer = _gpd.read_file(add_root / "Demo_1F_Extra_Space.shp")
        _layer["floor_id"] = ids["level_id"]
        _layer.to_file(add_root / "Demo_1F_Extra_Space.shp", driver="ESRI Shapefile", index=False)

        plan = _stage(test_client, session_id, add_root)
        assert plan["needs_decisions"] is True, "2F is unmatched, so it would normally be asked about"

        # Pick one room on 1F and nothing on 2F: no answer about 2F is needed.
        status, result = _commit(
            test_client,
            session_id,
            {
                "batch_id": plan["batch_id"],
                "selection": {"base": "picked", "included_feature_ids": [MIXED_IDS[0]]},
            },
        )

    assert status == 200, result
    assert result["added_features"] == 1
    assert result["created_level_ids"] == []
    assert new_level_id in result["rejected_level_ids"]

    features = _features(test_client, session_id)
    assert [item["id"] for item in features if item["feature_type"] == "level"] == [ids["level_id"]]
    added = {item["id"] for item in features if item["properties"].get("import_batch_id") == plan["batch_id"]}
    assert added == {MIXED_IDS[0]}


@pytest.mark.phase5
def test_the_stage_plan_reports_the_crs_each_layer_declared(test_client) -> None:
    """Reprojection is invisible when it works and catastrophic when it does not,
    so what the .prj said is worth showing rather than trusting."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-55555555555a"],
            geometries=[_square(139.7006, 35.6902)],
        )
        with_prj = _stage(test_client, session_id, add_root)

        # The same layer with its .prj withheld: nothing tells the reader the
        # coordinates were taken as degrees, so the plan has to.
        (add_root / "Demo_1F_Fixture.prj").unlink()
        response = test_client.post(
            f"/api/session/{session_id}/import/stage",
            files=_upload_all_shapefiles(add_root),
        )

    assert with_prj["files"][0]["crs_detected"] == "EPSG:4326"

    assert response.status_code == 201, response.text
    without_prj = response.json()
    assert without_prj["files"][0]["crs_detected"] is None
    assert any("missing .prj" in warning for warning in without_prj["warnings"])


def _write_echo_layer(root: Path, ids: dict[str, str], *, stem: str, extra: list[str] | None = None) -> None:
    """A layer holding the host's own features, at the host's own coordinates.

    Three of them, because one match cannot tell a datum shift from a room that
    simply moved.
    """
    echoed = [
        (ids["unit_id"], _square(139.7002, 35.6902, 0.0002)),
        (ids["section_id"], _square(139.7005, 35.6905, 0.0001)),
        (ids["amenity_id"], _square(139.70025, 35.69025, 0.0001)),
    ]
    for index, new_id in enumerate(extra or []):
        echoed.append((new_id, _square(139.7008 + index * 0.0003, 35.6902)))
    _write_space_layer(
        root,
        stem=stem,
        unit_ids=[item[0] for item in echoed],
        geometries=[item[1] for item in echoed],
    )


def _shift_layer(root: Path, stem: str, *, east_m: float, north_m: float) -> None:
    """Move a written layer by a fixed ground distance, as a datum offset would."""
    import math

    layer = gpd.read_file(root / f"{stem}.shp")
    lat = float(layer.geometry.iloc[0].centroid.y)
    layer["geometry"] = layer.geometry.translate(
        xoff=east_m / (111_320.0 * math.cos(math.radians(lat))),
        yoff=north_m / 110_540.0,
    )
    layer.to_file(root / f"{stem}.shp", driver="ESRI Shapefile", index=False)


@pytest.mark.phase5
def test_a_constant_offset_between_the_batch_and_the_dataset_is_measured(test_client) -> None:
    """Two producers can both say WGS84 and disagree by most of a metre.

    PROJ treats JGD2011 as identical to WGS84; an epoch-aware pipeline shifts by
    however far the plate has moved. The gap is measured on features present in
    both rather than guessed at.
    """
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        # The same rooms as the host, moved the way the real datasets differ.
        _write_echo_layer(add_root, ids, stem="Demo_1F_Again_Space")
        _shift_layer(add_root, "Demo_1F_Again_Space", east_m=-0.76, north_m=-0.35)
        plan = _stage(test_client, session_id, add_root)

    alignment = plan["alignment"]
    assert alignment is not None, "the host and the batch share ids, so the gap is measurable"
    assert alignment["sample_count"] >= 3
    assert alignment["distance_metres"] == pytest.approx(0.837, abs=0.05)
    assert alignment["east_metres"] == pytest.approx(0.76, abs=0.05)
    assert alignment["north_metres"] == pytest.approx(0.35, abs=0.05)
    assert alignment["consistent"] is True
    assert alignment["from_session"] is False


@pytest.mark.phase5
def test_the_measured_offset_is_applied_only_when_asked(test_client) -> None:
    from shapely.geometry import shape as _shape

    added_id = "dd000000-0000-4000-8000-0000000000f2"
    results = {}
    for apply_it in (False, True):
        with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
            session_id, ids = _start_session(test_client, Path(host_dir))
            add_root = Path(add_dir)
            _write_echo_layer(add_root, ids, stem="Demo_1F_Again_Space", extra=[added_id])
            _shift_layer(add_root, "Demo_1F_Again_Space", east_m=-0.76, north_m=-0.35)
            plan = _stage(test_client, session_id, add_root)
            status, result = _commit(
                test_client,
                session_id,
                {
                    "batch_id": plan["batch_id"],
                    "on_id_collision": "remint",
                    "apply_alignment": apply_it,
                },
            )
            assert status == 200, result
            feature = next(
                item for item in _features(test_client, session_id)
                if item["properties"].get("source_file") == "Demo_1F_Again_Space"
                and item["properties"].get("name", {}).get("en") == "Added 3"
            )
            results[apply_it] = _shape(feature["geometry"]).centroid
            results[f"result_{apply_it}"] = result

    # Untouched, the added room sits where the shapefile put it.
    assert results["result_False"]["alignment_applied"] is None
    # Shifted, it lands where the dataset's own frame puts it: the difference
    # between the two is exactly the measured offset.
    applied = results["result_True"]["alignment_applied"]
    assert applied is not None
    assert applied["distance_metres"] == pytest.approx(0.837, abs=0.05)

    import math

    moved_east = (results[True].x - results[False].x) * 111_320.0 * math.cos(math.radians(results[True].y))
    moved_north = (results[True].y - results[False].y) * 110_540.0
    assert moved_east == pytest.approx(0.76, abs=0.05)
    assert moved_north == pytest.approx(0.35, abs=0.05)


@pytest.mark.phase5
def test_the_offset_is_remembered_for_a_later_batch_with_nothing_in_common(test_client) -> None:
    """The point of appending is new features, which by definition share no ids."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_echo_layer(add_root, ids, stem="Demo_1F_Again_Space")
        _shift_layer(add_root, "Demo_1F_Again_Space", east_m=-0.76, north_m=-0.35)
        first = _stage(test_client, session_id, add_root)
        assert _commit(
            test_client, session_id,
            {"batch_id": first["batch_id"], "apply_alignment": True},
        )[0] == 200

        # A second batch of genuinely new rooms: nothing to measure against.
        second_root = Path(add_dir) / "second"
        second_root.mkdir()
        _write_space_layer(
            second_root,
            stem="Demo_1F_New_Space",
            unit_ids=["dd000000-0000-4000-8000-0000000000f3"],
            geometries=[_square(139.7008, 35.6902)],
        )
        second = _stage(test_client, session_id, second_root)

    alignment = second["alignment"]
    assert alignment is not None, "the session remembers what it learned from the first batch"
    assert alignment["from_session"] is True
    assert alignment["distance_metres"] == pytest.approx(0.837, abs=0.05)


@pytest.mark.phase5
def test_an_inconsistent_gap_is_reported_rather_than_applied_blindly(test_client) -> None:
    """A blanket shift only makes sense when the gap is actually constant."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Again_Space",
            unit_ids=[ids["unit_id"], ids["section_id"], ids["amenity_id"]],
            # Each one a different distance from where the host has it.
            geometries=[
                _square(139.7002, 35.6902),
                _square(139.7050, 35.6950),
                _square(139.7100, 35.6990),
            ],
        )
        plan = _stage(test_client, session_id, add_root)

    alignment = plan["alignment"]
    if alignment is not None:
        assert alignment["consistent"] is False
        assert alignment["spread_cm"] > 25.0


@pytest.mark.phase5
def test_the_batch_tag_does_not_reach_the_exported_imdf(test_client) -> None:
    """It exists for the review screen; IMDF has no such property."""
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, _ = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root,
            stem="Demo_1F_Fixture",
            unit_ids=["55555555-5555-4555-8555-55555555556b"],
            geometries=[_square(139.7006, 35.6902)],
        )
        plan = _stage(test_client, session_id, add_root)
        assert _commit(test_client, session_id, {"batch_id": plan["batch_id"]})[0] == 200

        # It is on the feature in the session, where the panel needs it...
        added = next(
            item for item in _features(test_client, session_id)
            if item["properties"].get("import_batch_id") == plan["batch_id"]
        )
        assert added["properties"]["import_batch_id"] == plan["batch_id"]

        export = test_client.get(f"/api/session/{session_id}/export")
        assert export.status_code == 200

    # ...and on nothing in the archive.
    with zipfile.ZipFile(BytesIO(export.content)) as archive:
        for name in archive.namelist():
            if not name.endswith(".geojson"):
                continue
            payload = json.loads(archive.read(name))
            for feature in payload.get("features", []):
                assert "import_batch_id" not in (feature.get("properties") or {}), name


@pytest.mark.phase5
def test_a_floor_grows_to_hold_what_was_added_past_its_edge(test_client) -> None:
    """Apple calls a unit outside its level an "Invalid level reference", which
    reads like a broken id rather than a floor plate that stops too soon."""
    from shapely.geometry import shape as _shape

    outside_id = "55555555-5555-4555-8555-55555555556c"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        level_before = _shape(
            next(item for item in _features(test_client, session_id) if item["id"] == ids["level_id"])["geometry"]
        )
        add_root = Path(add_dir)
        # Well clear of the 1F floor plate, the way an outdoor walkway is.
        _write_space_layer(
            add_root,
            stem="Demo_1F_Outer_Space",
            unit_ids=[outside_id],
            geometries=[_square(139.7020, 35.6920)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(test_client, session_id, {"batch_id": plan["batch_id"]})

    assert status == 200, result
    assert result["expanded_level_ids"] == [ids["level_id"]]

    features = _features(test_client, session_id)
    level_after = _shape(next(item for item in features if item["id"] == ids["level_id"])["geometry"])
    added = _shape(next(item for item in features if item["id"] == outside_id)["geometry"])

    assert not level_before.contains(added), "it started outside, or the test proves nothing"
    assert level_after.contains(added), "the floor grew to hold it"
    assert level_after.contains(level_before), "and kept everything it already covered"

    validation = test_client.post(f"/api/session/{session_id}/validate").json()
    outside_warnings = [
        issue for issue in validation["warnings"] if issue["check"] == "unit_outside_level_warning"
    ]
    assert outside_warnings == []


@pytest.mark.phase5
def test_expanding_can_be_declined(test_client) -> None:
    outside_id = "55555555-5555-4555-8555-55555555556d"
    with tempfile.TemporaryDirectory() as host_dir, tempfile.TemporaryDirectory() as add_dir:
        session_id, ids = _start_session(test_client, Path(host_dir))
        add_root = Path(add_dir)
        _write_space_layer(
            add_root, stem="Demo_1F_Outer_Space", unit_ids=[outside_id],
            geometries=[_square(139.7020, 35.6920)],
        )
        plan = _stage(test_client, session_id, add_root)
        status, result = _commit(
            test_client, session_id,
            {"batch_id": plan["batch_id"], "expand_levels": False},
        )

    assert status == 200, result
    assert result["expanded_level_ids"] == []
    validation = test_client.post(f"/api/session/{session_id}/validate").json()
    assert any(issue["check"] == "unit_outside_level_warning" for issue in validation["warnings"])
