"""Project view of shapefile sessions: content revisions, stage and meta v2."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
from pathlib import Path
from typing import Any, Callable

import pytest

from backend.src.projects import derive_session_project, mark_changed, mark_delivered, mark_validated, reset_generation
from backend.src.schemas import (
    AddressInput,
    CleanupSummary,
    ImportedFile,
    ProjectWizardState,
    SessionRecord,
    ValidationIssue,
    ValidationResponse,
    ValidationSummary,
)
from backend.src.session import FileSystemSessionBackend, SessionManager
from backend.tests.test_api import _upload_payload

_PROJECT = {
    "project_name": "Tokyo Station",
    "venue_name": "Tokyo Station",
    "venue_category": "transitstation",
    "language": "en",
    "address": {"address": "1-9-1 Marunouchi", "locality": "Chiyoda-ku", "country": "JP"},
}


def _file(stem: str) -> ImportedFile:
    return ImportedFile(stem=stem, geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")


def _record(**overrides: Any) -> SessionRecord:
    now = datetime(2026, 9, 1, tzinfo=UTC)
    values: dict[str, Any] = {
        "session_id": "s-1",
        "created_at": now,
        "last_accessed": now,
        "files": [_file("JRTokyoSta_B1_Space"), _file("JRTokyoSta_GF_Space")],
        "cleanup_summary": CleanupSummary(),
        "feature_collection": {"type": "FeatureCollection", "features": []},
    }
    values.update(overrides)
    return SessionRecord(**values)


def _project(**overrides: Any) -> ProjectWizardState:
    values: dict[str, Any] = {
        "venue_name": "Tokyo Station",
        "venue_category": "transitstation",
        "address": AddressInput(locality="Chiyoda-ku", country="JP"),
    }
    values.update(overrides)
    return ProjectWizardState(**values)


def _validation(errors: int, warnings: int = 0) -> ValidationResponse:
    issue = {"check": "c", "message": "m"}
    return ValidationResponse(
        errors=[ValidationIssue(**issue, severity="error") for _ in range(errors)],
        warnings=[ValidationIssue(**issue, severity="warning") for _ in range(warnings)],
        summary=ValidationSummary(error_count=errors, warning_count=warnings),
    )


def _venue(name: dict[str, str]) -> dict[str, Any]:
    return {"type": "Feature", "id": "v", "feature_type": "venue", "geometry": None, "properties": {"name": name}}


def _generated(record: SessionRecord) -> SessionRecord:
    record.wizard.project = _project()
    record.wizard.generation_status = "generated"
    mark_changed(record)
    return record


def _fresh_import() -> SessionRecord:
    return _record()


def _project_set() -> SessionRecord:
    record = _record()
    record.wizard.project = _project()
    mark_changed(record)
    return record


def _generated_unvalidated() -> SessionRecord:
    return _generated(_record())


def _validated_with_errors() -> SessionRecord:
    record = _generated(_record())
    mark_validated(record, _validation(errors=2, warnings=3))
    return record


def _validated_clean() -> SessionRecord:
    record = _generated(_record())
    mark_validated(record, _validation(errors=0, warnings=3))
    return record


def _clean_then_feature_edit() -> SessionRecord:
    record = _validated_clean()
    mark_changed(record)
    return record


def _clean_then_wizard_edit() -> SessionRecord:
    record = _validated_clean()
    reset_generation(record)
    return record


def _imdf_archive_import() -> SessionRecord:
    record = _record(files=[], feature_collection={"type": "FeatureCollection", "features": [_venue({"ja": "東京駅"})]})
    record.wizard.generation_status = "generated"
    return record


def _imdf_shapefile_import() -> SessionRecord:
    record = _record(import_profile="imdf_shapefile")
    record.wizard.generation_status = "generated"
    return record


def _delivered_with_errors() -> SessionRecord:
    record = _validated_with_errors()
    mark_delivered(record, "imdf", 2)
    return record


def _delivered_then_edited() -> SessionRecord:
    record = _delivered_with_errors()
    mark_changed(record)
    return record


def _delivered_then_wizard_edit() -> SessionRecord:
    record = _delivered_with_errors()
    reset_generation(record)
    return record


def _delivered_edited_and_clean() -> SessionRecord:
    record = _delivered_then_edited()
    mark_validated(record, _validation(errors=0))
    return record


def _delivered_then_revalidated() -> SessionRecord:
    record = _delivered_with_errors()
    mark_validated(record, _validation(errors=2))
    return record


@pytest.mark.phase5
@pytest.mark.parametrize(
    ("build", "stage", "blockers", "can_wait", "changed_since_delivery"),
    [
        (_fresh_import, "bring-in", None, None, False),
        (_project_set, "set-up", None, None, False),
        (_generated_unvalidated, "check", None, None, False),
        (_validated_with_errors, "check", 2, 3, False),
        (_validated_clean, "deliver", 0, 3, False),
        (_clean_then_feature_edit, "check", None, None, False),
        (_clean_then_wizard_edit, "set-up", None, None, False),
        (_imdf_archive_import, "check", None, None, False),
        (_imdf_shapefile_import, "check", None, None, False),
        (_delivered_with_errors, "deliver", 2, 3, False),
        (_delivered_then_revalidated, "deliver", 2, 0, False),
        (_delivered_then_edited, "check", None, None, True),
        (_delivered_then_wizard_edit, "set-up", None, None, True),
        (_delivered_edited_and_clean, "deliver", 0, 0, True),
    ],
    ids=lambda value: value.__name__.strip("_") if callable(value) else None,
)
def test_stage_derivation(
    build: Callable[[], SessionRecord],
    stage: str,
    blockers: int | None,
    can_wait: int | None,
    changed_since_delivery: bool,
) -> None:
    project = derive_session_project(build())
    assert project.stage == stage
    assert project.blockers == blockers
    assert project.can_wait == can_wait
    assert project.changed_since_delivery is changed_since_delivery


@pytest.mark.phase5
def test_a_wizard_edit_clears_validation() -> None:
    record = _clean_then_wizard_edit()
    assert record.validation is None
    assert record.validation_rev is None
    assert record.wizard.generation_status == "not_started"


@pytest.mark.phase5
@pytest.mark.parametrize(
    ("build", "name"),
    [
        (lambda: _record(), "JRTokyoSta"),
        (lambda: _record(files=[_file("Shinjuku_1F_Space")]), "Shinjuku_1F_Space"),
        (lambda: _record(files=[_file("A_Space"), _file("B_Space")]), None),
        (lambda: _imdf_archive_import(), "東京駅"),
        (
            lambda: _record(feature_collection={"type": "FeatureCollection", "features": [_venue({"en": " ", "ja": "新宿駅"})]}),
            "新宿駅",
        ),
        (lambda: _project_set(), "Tokyo Station"),
    ],
    ids=["file-prefix", "single-file", "no-common-prefix", "imdf-venue", "venue-skips-blank", "venue-name"],
)
def test_name_chain(build: Callable[[], SessionRecord], name: str | None) -> None:
    assert derive_session_project(build()).name == name


@pytest.mark.phase5
def test_project_name_wins_over_venue_name() -> None:
    record = _record()
    record.wizard.project = _project(project_name="Marunouchi rebuild")
    assert derive_session_project(record).name == "Marunouchi rebuild"


@pytest.mark.phase5
def test_updated_at_follows_content_not_reads() -> None:
    record = _record()
    assert derive_session_project(record).updated_at == record.created_at
    mark_changed(record)
    changed_at = record.content_changed_at
    record.last_accessed = datetime.now(UTC) + timedelta(hours=1)
    mark_validated(record, _validation(errors=0))
    mark_delivered(record, "imdf", 0)
    assert derive_session_project(record).updated_at == changed_at


# --- routes ------------------------------------------------------------------


def _stored(client, session_id: str) -> SessionRecord:
    session = client.app.state.session_manager.get_session(session_id, touch=False)
    assert session is not None
    return session


def _rev(client, session_id: str) -> int:
    return _stored(client, session_id).content_rev


def _import(client, sample_dir: Path) -> str:
    files = [
        *_upload_payload(sample_dir, "JRTokyoSta_B1_Space"),
        *_upload_payload(sample_dir, "JRTokyoSta_B1_Opening"),
        *_upload_payload(sample_dir, "JRTokyoSta_GF_Space"),
    ]
    response = client.post("/api/import", files=files)
    assert response.status_code == 201, response.text
    return response.json()["session_id"]


def _generated_session(client, sample_dir: Path) -> str:
    session_id = _import(client, sample_dir)
    assert client.patch(f"/api/session/{session_id}/wizard/project", json=_PROJECT).status_code == 200
    assert client.post(f"/api/session/{session_id}/generate").status_code == 200
    return session_id


def _features(client, session_id: str, feature_type: str) -> list[dict[str, Any]]:
    features = client.get(f"/api/session/{session_id}/features").json()["features"]
    return [item for item in features if item["feature_type"] == feature_type]


def _overlap_two_units(client, session_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    keep, clip = _features(client, session_id, "unit")[:2]
    response = client.patch(f"/api/session/{session_id}/features/{clip['id']}", json={"geometry": keep["geometry"]})
    assert response.status_code == 200
    assert client.post(f"/api/session/{session_id}/validate").status_code == 200
    return keep, clip


def _prepare_nothing(client, session_id: str) -> dict[str, Any]:
    return {}


def _prepare_overlap(client, session_id: str) -> dict[str, Any]:
    keep, clip = _overlap_two_units(client, session_id)
    return {"keep": keep["id"], "clip": clip["id"]}


def _prepare_imprecise_unit(client, session_id: str) -> dict[str, Any]:
    unit = _features(client, session_id, "unit")[0]
    ring = [[x + 1e-11, y + 1e-11] for x, y in unit["geometry"]["coordinates"][0][:-1]]
    ring.append(ring[0])
    geometry = {"type": "Polygon", "coordinates": [ring]}
    assert client.patch(f"/api/session/{session_id}/features/{unit['id']}", json={"geometry": geometry}).status_code == 200
    assert client.post(f"/api/session/{session_id}/validate").status_code == 200
    return {}


def _prepare_retyped_file(client, session_id: str) -> dict[str, Any]:
    response = client.patch(f"/api/session/{session_id}/files/JRTokyoSta_GF_Space", json={"detected_type": "fixture"})
    assert response.status_code == 200
    return {}


def _prepare_ids(client, session_id: str) -> dict[str, Any]:
    units = _features(client, session_id, "unit")
    openings = _features(client, session_id, "opening")
    return {"units": [item["id"] for item in units], "opening": openings[0]["id"] if openings else None}


_LEVELS = {"items": [{"stem": "JRTokyoSta_B1_Space", "ordinal": -1, "name": "B1", "short_name": "B1"}]}
_BUILDINGS = {
    "buildings": [
        {
            "id": "building-1",
            "name": "Main",
            "category": "unspecified",
            "restriction": None,
            "file_stems": ["JRTokyoSta_B1_Space"],
            "address_mode": "same_as_venue",
            "address": None,
        }
    ]
}
_COMPANY_MAPPINGS = json.dumps({"default_category": "unspecified", "mappings": {"SHOP": "retail"}}).encode("utf-8")


_WIZARD_ROUTES: list[tuple[str, Callable[[Any, str, dict[str, Any]], Any]]] = [
    ("project", lambda c, s, _: c.patch(f"/api/session/{s}/wizard/project", json={**_PROJECT, "project_name": "Renamed"})),
    ("levels", lambda c, s, _: c.patch(f"/api/session/{s}/wizard/levels", json=_LEVELS)),
    ("buildings", lambda c, s, _: c.patch(f"/api/session/{s}/wizard/buildings", json=_BUILDINGS)),
    ("mappings", lambda c, s, _: c.patch(f"/api/session/{s}/wizard/mappings", json={"detail_confirmed": True})),
    ("footprint", lambda c, s, _: c.patch(f"/api/session/{s}/wizard/footprint", json={"method": "union_buffer", "footprint_buffer_m": 2.5})),
    (
        "company-mappings",
        lambda c, s, _: c.post(
            f"/api/session/{s}/config/company-mappings",
            files={"file": ("company_mappings.json", _COMPANY_MAPPINGS, "application/json")},
        ),
    ),
]

_MUTATING_ROUTES: list[tuple[str, Callable, Callable[[Any, str, dict[str, Any]], Any]]] = [
    *[(name, _prepare_nothing, call) for name, call in _WIZARD_ROUTES],
    ("generate", _prepare_nothing, lambda c, s, _: c.post(f"/api/session/{s}/generate")),
    ("detect", _prepare_retyped_file, lambda c, s, _: c.post(f"/api/session/{s}/detect")),
    (
        "patch-file",
        _prepare_nothing,
        lambda c, s, _: c.patch(f"/api/session/{s}/files/JRTokyoSta_GF_Space", json={"level_name": "Ground"}),
    ),
    (
        "patch-feature",
        _prepare_ids,
        lambda c, s, ctx: c.patch(f"/api/session/{s}/features/{ctx['units'][0]}", json={"properties": {"category": "room"}}),
    ),
    ("delete-feature", _prepare_ids, lambda c, s, ctx: c.delete(f"/api/session/{s}/features/{ctx['units'][0]}")),
    (
        "bulk-patch",
        _prepare_ids,
        lambda c, s, ctx: c.patch(
            f"/api/session/{s}/features/bulk",
            json={"feature_ids": ctx["units"][:3], "action": "patch", "properties": {"category": "room"}},
        ),
    ),
    (
        "bulk-delete",
        _prepare_ids,
        lambda c, s, ctx: c.patch(f"/api/session/{s}/features/bulk", json={"feature_ids": ctx["units"][:2], "action": "delete"}),
    ),
    (
        "bulk-merge",
        _prepare_ids,
        lambda c, s, ctx: c.patch(
            f"/api/session/{s}/features/bulk", json={"feature_ids": ctx["units"][:2], "action": "merge_units"}
        ),
    ),
    (
        "overlaps-resolve",
        _prepare_overlap,
        lambda c, s, ctx: c.post(
            f"/api/session/{s}/overlaps/resolve", json={"keep_feature_id": ctx["keep"], "clip_feature_id": ctx["clip"]}
        ),
    ),
    ("overlaps-fix-safe", _prepare_overlap, lambda c, s, _: c.post(f"/api/session/{s}/overlaps/fix-safe")),
    ("autofix", _prepare_imprecise_unit, lambda c, s, _: c.post(f"/api/session/{s}/autofix", json={"apply_prompted": False})),
    (
        "snap-opening",
        _prepare_ids,
        lambda c, s, ctx: c.post(
            f"/api/session/{s}/snap_opening", json={"opening_id": ctx["opening"], "unit_id": ctx["units"][0]}
        ),
    ),
]


@pytest.mark.phase5
@pytest.mark.parametrize(("prepare", "call"), [(p, c) for _, p, c in _MUTATING_ROUTES], ids=[n for n, _, _ in _MUTATING_ROUTES])
def test_each_mutating_route_bumps_content_rev_once(test_client, sample_dir: Path, prepare, call) -> None:
    session_id = _generated_session(test_client, sample_dir)
    context = prepare(test_client, session_id)
    before = _stored(test_client, session_id)
    rev, changed_at = before.content_rev, before.content_changed_at

    response = call(test_client, session_id, context)

    assert response.status_code in (200, 201), response.text
    after = _stored(test_client, session_id)
    assert after.content_rev == rev + 1
    assert after.content_changed_at > changed_at


@pytest.mark.phase5
@pytest.mark.parametrize("call", [call for _, call in _WIZARD_ROUTES], ids=[name for name, _ in _WIZARD_ROUTES])
def test_wizard_edits_after_a_clean_validation_return_to_set_up(test_client, sample_dir: Path, call) -> None:
    session_id = _generated_session(test_client, sample_dir)
    assert test_client.post(f"/api/session/{session_id}/validate").status_code == 200
    assert _stored(test_client, session_id).validation is not None

    assert call(test_client, session_id, {}).status_code == 200

    session = _stored(test_client, session_id)
    assert session.validation is None
    assert session.wizard.generation_status == "not_started"
    assert derive_session_project(session).stage == "set-up"


@pytest.mark.phase5
def test_reads_validation_and_exports_leave_content_rev_alone(test_client, sample_dir: Path, monkeypatch) -> None:
    _fake_qgis(monkeypatch)
    session_id = _generated_session(test_client, sample_dir)
    rev = _rev(test_client, session_id)
    changed_at = _stored(test_client, session_id).content_changed_at
    unit_id = _features(test_client, session_id, "unit")[0]["id"]

    calls = [
        lambda: test_client.get(f"/api/session/{session_id}/wizard"),
        lambda: test_client.get(f"/api/session/{session_id}/files"),
        lambda: test_client.get(f"/api/session/{session_id}/features"),
        lambda: test_client.get(f"/api/session/{session_id}/features/{unit_id}"),
        lambda: test_client.get(f"/api/session/{session_id}/wizard/footprint-preview"),
        lambda: test_client.post(f"/api/session/{session_id}/validate"),
        lambda: test_client.get(f"/api/session/{session_id}/export"),
        lambda: test_client.post(f"/api/session/{session_id}/export/shapefiles", json={}),
        lambda: test_client.post(f"/api/session/{session_id}/export/qgis", json={"export_name": "Demo"}),
        lambda: test_client.patch(f"/api/session/{session_id}/features/bulk", json={"feature_ids": [], "action": "delete"}),
    ]
    for call in calls:
        response = call()
        assert response.status_code == 200, response.text
        assert _rev(test_client, session_id) == rev

    session = _stored(test_client, session_id)
    assert session.content_changed_at == changed_at
    assert derive_session_project(session).changed_since_delivery is False


def _fake_qgis(monkeypatch) -> None:
    import zipfile

    def _fake_generate(folder: Path, output_qgz: Path, station: str) -> None:
        with zipfile.ZipFile(Path(output_qgz), mode="w") as project:
            project.writestr(f"{Path(output_qgz).stem}.qgs", "<qgis version='3.40'></qgis>")

    monkeypatch.setattr("backend.src.qgis_export.generate_qgis_project_for_folder", _fake_generate)


@pytest.mark.phase5
@pytest.mark.parametrize(
    ("method", "path", "body", "export_format"),
    [
        ("get", "export", None, "imdf"),
        ("get", "export?ext=zip", None, "imdf_zip"),
        ("post", "export/shapefiles", {}, "shapefiles:imdf_roundtrip"),
        ("post", "export/shapefiles", {"profile": "odc2026", "export_name": "Demo"}, "shapefiles:odc2026"),
        ("post", "export/qgis", {"export_name": "Demo"}, "qgis"),
    ],
    ids=["imdf", "imdf-zip", "shapefiles", "shapefiles-odc", "qgis"],
)
def test_every_export_marks_delivery_with_the_blocker_count(
    test_client, sample_dir: Path, monkeypatch, method: str, path: str, body, export_format: str
) -> None:
    _fake_qgis(monkeypatch)
    session_id = _generated_session(test_client, sample_dir)
    _overlap_two_units(test_client, session_id)
    unit = _features(test_client, session_id, "unit")[0]
    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}",
        json={"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]}},
    ).status_code == 200
    expected = test_client.post(f"/api/session/{session_id}/validate").json()["summary"]["error_count"]
    assert expected > 0
    unit = _features(test_client, session_id, "unit")[1]
    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit['id']}", json={"properties": {"category": "room"}}
    ).status_code == 200
    assert _stored(test_client, session_id).validation_rev != _rev(test_client, session_id)

    before = datetime.now(UTC)
    kwargs = {"json": body} if body is not None else {}
    response = getattr(test_client, method)(f"/api/session/{session_id}/{path}", **kwargs)
    assert response.status_code == 200, response.text

    session = _stored(test_client, session_id)
    assert session.delivered is not None
    assert session.delivered.format == export_format
    assert session.delivered.rev == session.content_rev
    assert session.delivered.blockers == expected
    assert session.delivered.at >= before
    project = derive_session_project(session)
    assert project.stage == "deliver"
    assert project.delivered_blockers == expected
    assert project.changed_since_delivery is False


@pytest.mark.phase5
def test_changed_since_delivery_flips_only_on_a_real_edit(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    assert test_client.get(f"/api/session/{session_id}/export").status_code == 200

    for _ in range(2):
        assert test_client.get(f"/api/session/{session_id}/wizard").status_code == 200
        assert test_client.post(f"/api/session/{session_id}/validate").status_code == 200
        assert test_client.get(f"/api/session/{session_id}/export").status_code == 200
        assert derive_session_project(_stored(test_client, session_id)).changed_since_delivery is False

    unit_id = _features(test_client, session_id, "unit")[0]["id"]
    assert test_client.patch(
        f"/api/session/{session_id}/features/{unit_id}", json={"properties": {"category": "room"}}
    ).status_code == 200
    project = derive_session_project(_stored(test_client, session_id))
    assert project.changed_since_delivery is True
    assert project.stage == "check"


@pytest.mark.phase5
def test_imports_start_at_revision_zero_in_their_stage(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    session = _stored(test_client, session_id)
    assert session.content_rev == 0
    assert session.delivered is None
    project = derive_session_project(session)
    assert project.stage == "bring-in"
    assert project.name == "JRTokyoSta"


# --- meta v2 -------------------------------------------------------------------


def _create(manager: SessionManager, stem: str = "Shinjuku_1F_Space") -> SessionRecord:
    return manager.create_session(
        files=[_file(stem)],
        cleanup_summary=CleanupSummary(),
        feature_collection={"type": "FeatureCollection", "features": []},
    )


def _delivered_session(manager: SessionManager) -> SessionRecord:
    session = _create(manager)
    session.wizard.project = _project(project_name="Shinjuku")
    session.wizard.generation_status = "generated"
    mark_changed(session)
    mark_validated(session, _validation(errors=1, warnings=4))
    mark_delivered(session, "imdf", 1)
    mark_changed(session)
    manager.save_session(session)
    return session


@pytest.mark.phase1
def test_meta_v2_round_trips_the_derived_fields(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _delivered_session(manager)
    expected = derive_session_project(session)

    meta = json.loads((tmp_path / f"{session.session_id}.meta.json").read_text(encoding="utf-8"))
    assert meta["meta_version"] == 2
    assert meta["name"] == "Shinjuku"
    assert meta["stage"] == "check"
    assert meta["changed_since_delivery"] is True
    assert meta["delivered_blockers"] == 1

    restarted = FileSystemSessionBackend(tmp_path)
    (summary,) = restarted.list_summaries()
    assert summary.project == expected
    assert summary.upload_artifact_dir == session.upload_artifact_dir


@pytest.mark.phase1
def test_version_1_meta_lists_with_an_unknown_project(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    last_accessed = datetime.now(UTC) - timedelta(hours=3)
    (tmp_path / f"{session.session_id}.meta.json").write_text(
        json.dumps(
            {"session_id": session.session_id, "last_accessed": last_accessed.isoformat(), "upload_artifact_dir": None}
        ),
        encoding="utf-8",
    )

    restarted = FileSystemSessionBackend(tmp_path)
    (summary,) = restarted.list_summaries()
    assert summary.project is None
    assert summary.last_accessed == last_accessed

    assert restarted.get(session.session_id) is not None
    (summary,) = restarted.list_summaries()
    assert summary.project is not None
    assert summary.project.stage == "bring-in"


@pytest.mark.phase1
def test_malformed_meta_v2_fields_fall_back_to_defaults(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    meta_path = tmp_path / f"{session.session_id}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({"stage": "shipped", "blockers": "3", "updated_at": "yesterday", "changed_since_delivery": "yes"})
    del meta["name"]
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    (summary,) = FileSystemSessionBackend(tmp_path).list_summaries()
    assert summary.project is not None
    assert summary.project.stage is None
    assert summary.project.blockers is None
    assert summary.project.updated_at is None
    assert summary.project.changed_since_delivery is False
    assert summary.project.name is None


@pytest.mark.phase1
def test_restart_builds_the_index_from_meta_files_only(monkeypatch, tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    sessions = [_delivered_session(manager) for _ in range(4)]

    calls = {"count": 0}
    real_loads = json.loads

    def counting_loads(*args, **kwargs):
        calls["count"] += 1
        return real_loads(*args, **kwargs)

    def no_record_parse(*args, **kwargs):
        raise AssertionError("the index must not parse session records")

    monkeypatch.setattr("backend.src.session.json.loads", counting_loads)
    monkeypatch.setattr(SessionRecord, "from_stored", classmethod(no_record_parse))
    restarted = FileSystemSessionBackend(tmp_path)

    assert calls["count"] == len(sessions)
    summaries = {item.session_id: item for item in restarted.list_summaries()}
    for session in sessions:
        assert summaries[session.session_id].project == derive_session_project(session)


@pytest.mark.phase1
def test_get_keeps_the_derived_fields_in_the_index(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _delivered_session(manager)
    expected = derive_session_project(session)

    restarted = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    assert restarted.get_session(session.session_id) is not None
    (summary,) = restarted.backend.list_summaries()
    assert summary.project == expected


@pytest.mark.phase1
def test_version_1_records_load_with_default_project_fields(tmp_path: Path) -> None:
    manager = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24)
    session = _create(manager)
    path = tmp_path / f"{session.session_id}.json"
    record = json.loads(path.read_text(encoding="utf-8"))
    for key in ("content_rev", "content_changed_at", "validation_rev", "delivered"):
        del record[key]
    record["schema_version"] = 1
    record["validation"] = {"summary": {"error_count": 0}}
    path.write_text(json.dumps(record), encoding="utf-8")

    loaded = SessionManager(backend=FileSystemSessionBackend(tmp_path), ttl_hours=24).get_session(session.session_id)
    assert loaded is not None
    assert loaded.content_rev == 0
    assert loaded.validation_rev is None
    assert loaded.delivered is None
    assert loaded.content_changed_at == datetime.fromisoformat(record["last_accessed"])
    assert derive_session_project(loaded).blockers is None


def _delivered_route_session(client, sample_dir: Path) -> str:
    session_id = _generated_session(client, sample_dir)
    assert client.get(f"/api/session/{session_id}/export").status_code == 200
    session = _stored(client, session_id)
    assert derive_session_project(session).stage == "deliver"
    return session_id


def _assert_untouched(client, session_id: str, before: SessionRecord) -> None:
    after = _stored(client, session_id)
    assert after.content_rev == before.content_rev
    assert after.content_changed_at == before.content_changed_at
    assert after.validation == before.validation
    assert after.validation_rev == before.validation_rev
    assert after.delivered == before.delivered
    assert after.wizard.generation_status == "generated"
    project = derive_session_project(after)
    assert project.stage == "deliver"
    assert project.changed_since_delivery is False


@pytest.mark.phase5
@pytest.mark.parametrize("call", [call for _, call in _WIZARD_ROUTES], ids=[name for name, _ in _WIZARD_ROUTES])
def test_resending_an_unchanged_wizard_section_is_not_an_edit(test_client, sample_dir: Path, call) -> None:
    session_id = _generated_session(test_client, sample_dir)
    assert call(test_client, session_id, {}).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    assert test_client.get(f"/api/session/{session_id}/export").status_code == 200
    before = _stored(test_client, session_id).model_copy(deep=True)

    for _ in range(2):
        assert call(test_client, session_id, {}).status_code == 200
        _assert_untouched(test_client, session_id, before)


@pytest.mark.phase5
def test_opening_the_wizard_on_a_delivered_project_changes_nothing(test_client, sample_dir: Path) -> None:
    session_id = _delivered_route_session(test_client, sample_dir)
    before = _stored(test_client, session_id).model_copy(deep=True)

    wizard = test_client.get(f"/api/session/{session_id}/wizard").json()["wizard"]
    project = {key: value for key, value in wizard["project"].items() if value is not None}
    responses = [
        test_client.patch(f"/api/session/{session_id}/wizard/levels", json={"items": wizard["levels"]["items"]}),
        test_client.patch(f"/api/session/{session_id}/wizard/project", json=project),
        test_client.patch(f"/api/session/{session_id}/wizard/buildings", json={"buildings": wizard["buildings"]}),
        test_client.patch(f"/api/session/{session_id}/wizard/footprint", json=wizard["footprint"]),
        test_client.patch(
            f"/api/session/{session_id}/wizard/mappings",
            json={key: wizard["mappings"][key] for key in ("unit", "opening", "fixture", "detail_confirmed")},
        ),
    ]
    for response in responses:
        assert response.status_code == 200, response.text
    _assert_untouched(test_client, session_id, before)


_LEVEL_FILE_TYPES = {"unit", "opening", "fixture", "detail", "kiosk", "section"}


def _levels_as_the_wizard_sends_them(client, session_id: str) -> dict[str, Any]:
    """WizardPage.toLevelItemsFromFiles: built from the file list, names null until typed."""
    files = client.get(f"/api/session/{session_id}/files").json()["files"]
    return {
        "items": [
            {
                "stem": item["stem"],
                "detected_type": item["detected_type"],
                "ordinal": item["detected_level"],
                "name": item["level_name"],
                "short_name": item["short_name"],
                "outdoor": item["outdoor"],
                "category": item["level_category"],
            }
            for item in files
            if (item["detected_type"] or "") in _LEVEL_FILE_TYPES
        ]
    }


@pytest.mark.phase5
def test_the_wizards_level_sync_on_every_section_change_is_not_an_edit(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    import_files = _levels_as_the_wizard_sends_them(test_client, session_id)
    assert any(item["name"] is None for item in import_files["items"])
    assert test_client.get(f"/api/session/{session_id}/wizard").status_code == 200
    assert test_client.patch(f"/api/session/{session_id}/wizard/levels", json=import_files).status_code == 200
    assert test_client.patch(f"/api/session/{session_id}/wizard/project", json=_PROJECT).status_code == 200
    assert test_client.patch(f"/api/session/{session_id}/wizard/levels", json=import_files).status_code == 200
    assert test_client.post(f"/api/session/{session_id}/generate").status_code == 200
    assert test_client.get(f"/api/session/{session_id}/export").status_code == 200
    before = _stored(test_client, session_id).model_copy(deep=True)

    assert test_client.get(f"/api/session/{session_id}/wizard").status_code == 200
    for payload in (import_files, _levels_as_the_wizard_sends_them(test_client, session_id)) * 4:
        assert test_client.patch(f"/api/session/{session_id}/wizard/levels", json=payload).status_code == 200
        _assert_untouched(test_client, session_id, before)

    renamed = _levels_as_the_wizard_sends_them(test_client, session_id)
    renamed["items"][0]["name"] = "Concourse"
    assert test_client.patch(f"/api/session/{session_id}/wizard/levels", json=renamed).status_code == 200
    assert _rev(test_client, session_id) == before.content_rev + 1
    assert test_client.patch(f"/api/session/{session_id}/wizard/levels", json=renamed).status_code == 200
    assert _rev(test_client, session_id) == before.content_rev + 1


@pytest.mark.phase5
def test_a_wizard_edit_and_its_revert_each_count(test_client, sample_dir: Path) -> None:
    session_id = _delivered_route_session(test_client, sample_dir)
    rev = _rev(test_client, session_id)
    footprint = test_client.get(f"/api/session/{session_id}/wizard").json()["wizard"]["footprint"]

    changed = {**footprint, "venue_buffer_m": footprint["venue_buffer_m"] + 3}
    assert test_client.patch(f"/api/session/{session_id}/wizard/footprint", json=changed).status_code == 200
    assert _rev(test_client, session_id) == rev + 1
    assert test_client.patch(f"/api/session/{session_id}/wizard/footprint", json=changed).status_code == 200
    assert _rev(test_client, session_id) == rev + 1
    assert test_client.patch(f"/api/session/{session_id}/wizard/footprint", json=footprint).status_code == 200
    assert _rev(test_client, session_id) == rev + 2

    project = derive_session_project(_stored(test_client, session_id))
    assert project.changed_since_delivery is True
    assert project.stage == "set-up"


@pytest.mark.phase2
def test_a_rejected_file_patch_leaves_the_cached_record_alone(test_client, sample_dir: Path) -> None:
    session_id = _import(test_client, sample_dir)
    before = _stored(test_client, session_id).model_copy(deep=True)

    response = test_client.patch(
        f"/api/session/{session_id}/files/JRTokyoSta_GF_Space",
        json={"level_name": "Ground", "apply_learning": True},
    )
    assert response.status_code == 400, response.text

    after = _stored(test_client, session_id)
    assert after.files == before.files
    assert after.content_rev == before.content_rev


@pytest.mark.phase5
def test_resending_a_building_with_its_own_address_keeps_the_address_feature(test_client, sample_dir: Path) -> None:
    session_id = _generated_session(test_client, sample_dir)
    annex = {
        **_BUILDINGS["buildings"][0],
        "address_mode": "different_address",
        "address": {"address": "2-1-1 Annex Rd", "locality": "Chiyoda-ku", "country": "JP"},
    }
    body = {"buildings": [annex]}
    first = test_client.patch(f"/api/session/{session_id}/wizard/buildings", json=body)
    assert first.status_code == 200
    rev = _rev(test_client, session_id)

    second = test_client.patch(f"/api/session/{session_id}/wizard/buildings", json=body)
    assert second.status_code == 200
    assert _rev(test_client, session_id) == rev
    assert second.json()["address_features"][0]["id"] == first.json()["address_features"][0]["id"]
