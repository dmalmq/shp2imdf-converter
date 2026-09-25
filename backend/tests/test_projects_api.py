"""The project list: shapefile sessions and artwork conversions read from their metadata only."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import shutil
import threading
from uuid import uuid4

import pytest

from backend.src.illustrator_store import ConversionStore
from backend.src.project_limits import ProjectLimits
from backend.src.schemas import SessionRecord
from backend.src.session import FileSystemSessionBackend, SessionManager
from backend.tests.test_illustrator_api import _TRAVERSING_IDS, _preview
from backend.tests.test_session_projects import _PROJECT, _import

_UNKNOWN_SESSION = "00000000-0000-4000-8000-000000000000"
_UNKNOWN_CONVERSION = "0123456789abcdef0123456789abcdef"


def _session(client, sample_dir: Path, name: str | None = None) -> str:
    session_id = _import(client, sample_dir)
    if name is not None:
        project = {**_PROJECT, "project_name": name}
        assert client.patch(f"/api/session/{session_id}/wizard/project", json=project).status_code == 200
    return session_id


def _conversion(client) -> str:
    response = _preview(client)
    assert response.status_code == 200, response.text
    return response.json()["conversion_id"]


def _reopen_sessions(client) -> SessionManager:
    """A fresh backend over the same directory: nothing cached, index read from meta files."""
    current: SessionManager = client.app.state.session_manager
    manager = SessionManager(
        FileSystemSessionBackend(current.backend.data_dir),
        ttl_hours=int(current.ttl.total_seconds() // 3600),
        max_sessions=current.max_sessions,
    )
    client.app.state.session_manager = manager
    return manager


def _set_last_opened(client, session_id: str, when: datetime) -> None:
    manager: SessionManager = client.app.state.session_manager
    record = manager.get_session(session_id, touch=False)
    assert record is not None
    record.last_accessed = when
    manager.backend.touch(record)


def _set_artwork_last_opened(client, conversion_id: str, when: datetime) -> None:
    marker = client.app.state.illustrator_store.root / conversion_id / "last_used"
    os.utime(marker, (when.timestamp(), when.timestamp()))


def _forbid_record_reads(monkeypatch) -> None:
    def forbidden(*_args, **_kwargs):
        raise AssertionError("the project list must not load a record")

    monkeypatch.setattr(SessionRecord, "from_stored", classmethod(forbidden))
    monkeypatch.setattr(SessionRecord, "model_validate", classmethod(forbidden))
    monkeypatch.setattr(SessionRecord, "model_validate_json", classmethod(forbidden))
    monkeypatch.setattr(FileSystemSessionBackend, "get", forbidden)
    monkeypatch.setattr(ConversionStore, "get", forbidden)


def test_listing_parses_no_session_record_and_calls_no_get(test_client, sample_dir: Path, monkeypatch) -> None:
    session_ids = {_session(test_client, sample_dir), _session(test_client, sample_dir, "Named")}
    conversion_id = _conversion(test_client)
    _reopen_sessions(test_client)
    _forbid_record_reads(monkeypatch)

    sessions_dir = test_client.app.state.session_manager.backend.data_dir.resolve()
    real_read_text, real_read_bytes = Path.read_text, Path.read_bytes
    session_reads: list[str] = []

    def watch(real):
        def read(self: Path, *args, **kwargs):
            if self.resolve().parent == sessions_dir:
                session_reads.append(self.name)
            return real(self, *args, **kwargs)

        return read

    monkeypatch.setattr(Path, "read_text", watch(real_read_text))
    monkeypatch.setattr(Path, "read_bytes", watch(real_read_bytes))

    response = test_client.get("/api/projects")

    assert response.status_code == 200, response.text
    assert session_reads == []
    ids = {item["id"] for item in response.json()["projects"]}
    assert ids == session_ids | {conversion_id}
    for session_id in session_ids:
        assert test_client.get(f"/api/projects/shapefiles/{session_id}").status_code == 200
    assert test_client.get(f"/api/projects/artwork/{conversion_id}").status_code == 200
    assert session_reads == []


def test_listing_does_not_extend_any_lifetime(test_client, sample_dir: Path) -> None:
    session_id = _session(test_client, sample_dir, "Kept")
    conversion_id = _conversion(test_client)
    earlier = datetime.now(UTC) - timedelta(minutes=30)
    _set_last_opened(test_client, session_id, earlier)
    _set_artwork_last_opened(test_client, conversion_id, earlier)
    manager: SessionManager = test_client.app.state.session_manager
    marker = test_client.app.state.illustrator_store.root / conversion_id / "last_used"

    for path in ("/api/projects", f"/api/projects/shapefiles/{session_id}", f"/api/projects/artwork/{conversion_id}"):
        assert test_client.get(path).status_code == 200

    (summary,) = [item for item in manager.backend.list_summaries() if item.session_id == session_id]
    assert summary.last_accessed == earlier
    assert marker.stat().st_mtime == pytest.approx(earlier.timestamp(), abs=1e-3)
    listed = {item["id"]: item for item in test_client.get("/api/projects").json()["projects"]}
    assert datetime.fromisoformat(listed[session_id]["last_opened"]) == earlier
    artwork_opened = datetime.fromisoformat(listed[conversion_id]["last_opened"])
    assert artwork_opened.timestamp() == pytest.approx(earlier.timestamp(), abs=1e-3)


def test_listing_is_sorted_by_last_opened_then_id(test_client, sample_dir: Path) -> None:
    older, newer, tied_a, tied_b = (_session(test_client, sample_dir) for _ in range(4))
    conversion_id = _conversion(test_client)
    base = datetime.now(UTC) - timedelta(hours=1)
    _set_last_opened(test_client, older, base - timedelta(minutes=30))
    _set_last_opened(test_client, newer, base + timedelta(minutes=30))
    _set_last_opened(test_client, tied_a, base)
    _set_last_opened(test_client, tied_b, base)
    _set_artwork_last_opened(test_client, conversion_id, base + timedelta(minutes=10))

    ids = [item["id"] for item in test_client.get("/api/projects").json()["projects"]]

    assert ids == [newer, conversion_id, *sorted([tied_a, tied_b]), older]


def test_flow_filter_limit_and_total(test_client, sample_dir: Path) -> None:
    sessions = [_session(test_client, sample_dir) for _ in range(3)]
    conversions = [_conversion(test_client) for _ in range(2)]

    everything = test_client.get("/api/projects").json()
    assert everything["total"] == 5
    assert len(everything["projects"]) == 5

    shapefiles = test_client.get("/api/projects", params={"flow": "shapefiles"}).json()
    assert {item["id"] for item in shapefiles["projects"]} == set(sessions)
    assert {item["flow"] for item in shapefiles["projects"]} == {"shapefiles"}
    assert shapefiles["total"] == 3

    artwork = test_client.get("/api/projects", params={"flow": "artwork", "limit": 1}).json()
    assert len(artwork["projects"]) == 1
    assert artwork["projects"][0]["id"] in conversions
    assert artwork["total"] == 2

    assert test_client.get("/api/projects", params={"limit": 500}).status_code == 200
    for bad in ({"limit": 501}, {"limit": 0}, {"flow": "nonsense"}):
        response = test_client.get("/api/projects", params=bad)
        assert response.status_code == 422, bad
        assert response.json()["code"] == "VALIDATION_ERROR"


def test_limits_report_what_the_stores_were_built_with(test_client) -> None:
    limits: ProjectLimits = test_client.app.state.project_limits
    manager: SessionManager = test_client.app.state.session_manager
    store: ConversionStore = test_client.app.state.illustrator_store

    shapefiles = test_client.get("/api/projects", params={"flow": "shapefiles"}).json()["limits"]
    artwork = test_client.get("/api/projects", params={"flow": "artwork"}).json()["limits"]

    assert shapefiles["idle_days"] * 86400 == pytest.approx(manager.ttl.total_seconds())
    assert shapefiles["max_projects"] == manager.max_sessions == limits.sessions.max_projects
    assert artwork["idle_days"] * 86400 == pytest.approx(store.ttl_seconds)
    assert artwork["max_projects"] == store.max_entries == limits.artwork.max_projects


def test_limits_follow_legacy_overrides_and_take_the_stricter_flow(test_client) -> None:
    test_client.app.state.project_limits = ProjectLimits.from_env(
        {"PROJECT_IDLE_DAYS": "30", "MAX_PROJECTS": "200", "ILLUSTRATOR_CACHE_TTL_MINUTES": "120"}
    )

    shapefiles = test_client.get("/api/projects", params={"flow": "shapefiles"}).json()["limits"]
    artwork = test_client.get("/api/projects", params={"flow": "artwork"}).json()["limits"]
    both = test_client.get("/api/projects").json()["limits"]

    assert shapefiles == {"idle_days": 30, "max_projects": 200}
    assert artwork == {"idle_days": pytest.approx(2 / 24), "max_projects": 200}
    assert both == artwork


def test_single_project_summaries_for_both_flows(test_client, sample_dir: Path) -> None:
    session_id = _session(test_client, sample_dir, "Tokyo Station B1")
    conversion_id = _conversion(test_client)
    manager: SessionManager = test_client.app.state.session_manager

    shapefile = test_client.get(f"/api/projects/shapefiles/{session_id}").json()
    assert shapefile["id"] == session_id
    assert shapefile["flow"] == "shapefiles"
    assert shapefile["name"] == "Tokyo Station B1"
    assert shapefile["import_profile"] == "standard"
    assert shapefile["stage"] == "set-up"
    assert shapefile["delivered_at"] is None
    assert shapefile["changed_since_delivery"] is False
    last_opened = datetime.fromisoformat(shapefile["last_opened"])
    assert datetime.fromisoformat(shapefile["expires_at"]) == last_opened + manager.ttl
    assert shapefile["updated_at"] is not None

    artwork = test_client.get(f"/api/projects/artwork/{conversion_id}").json()
    assert artwork["id"] == conversion_id
    assert artwork["flow"] == "artwork"
    assert artwork["name"] == "sample"
    assert artwork["import_profile"] is None
    assert artwork["stage"] == "name-floors"
    assert artwork["can_wait"] is None
    listed = {item["id"]: item for item in test_client.get("/api/projects").json()["projects"]}
    assert listed[session_id] == shapefile
    assert listed[conversion_id] == artwork


_HOSTILE_IDS = [
    "%2E%2E",
    "%2E",
    "..%5Cvictim",
    "%2E%2E%5Cvictim",
    "%5C%5Chost.invalid%5Cx",
    "C:%5CWindows",
    "not%20an%20id",
]


@pytest.mark.parametrize("flow", ["shapefiles", "artwork"])
@pytest.mark.parametrize("encoded_id", _HOSTILE_IDS)
def test_hostile_ids_are_not_found_before_any_lookup(test_client, flow: str, encoded_id: str, monkeypatch) -> None:
    def forbidden(*_args, **_kwargs):
        raise AssertionError("an invalid id reached a store")

    monkeypatch.setattr(FileSystemSessionBackend, "summary", forbidden)
    monkeypatch.setattr(ConversionStore, "_summarise", forbidden)

    response = test_client.get(f"/api/projects/{flow}/{encoded_id}")

    assert response.status_code == 404, response.text
    assert response.json()["code"] == ("SESSION_NOT_FOUND" if flow == "shapefiles" else "CONVERSION_EXPIRED")


@pytest.mark.parametrize("encoded_id", _TRAVERSING_IDS)
def test_traversing_ids_are_not_artwork(test_client, encoded_id: str) -> None:
    response = test_client.get(f"/api/projects/artwork/{encoded_id}")
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "CONVERSION_EXPIRED"


@pytest.mark.parametrize(
    ("flow", "project_id", "code"),
    [("shapefiles", _UNKNOWN_SESSION, "SESSION_NOT_FOUND"), ("artwork", _UNKNOWN_CONVERSION, "CONVERSION_EXPIRED")],
)
def test_unknown_ids_are_not_found(test_client, flow: str, project_id: str, code: str) -> None:
    response = test_client.get(f"/api/projects/{flow}/{project_id}")
    assert response.status_code == 404
    assert response.json()["code"] == code


def test_a_session_id_is_not_found_as_artwork_and_back(test_client, sample_dir: Path) -> None:
    session_id = _session(test_client, sample_dir)
    conversion_id = _conversion(test_client)
    assert test_client.get(f"/api/projects/artwork/{session_id}").json()["code"] == "CONVERSION_EXPIRED"
    assert test_client.get(f"/api/projects/shapefiles/{conversion_id}").json()["code"] == "SESSION_NOT_FOUND"


def test_unknown_flow_is_rejected(test_client) -> None:
    response = test_client.get(f"/api/projects/other/{_UNKNOWN_CONVERSION}")
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_version_1_meta_session_lists_with_nulls(test_client, sample_dir: Path) -> None:
    session_id = _session(test_client, sample_dir, "Old")
    data_dir = test_client.app.state.session_manager.backend.data_dir
    meta_path = data_dir / f"{session_id}.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta_path.write_text(
        json.dumps({key: meta[key] for key in ("session_id", "last_accessed", "upload_artifact_dir")}),
        encoding="utf-8",
    )
    _reopen_sessions(test_client)

    (item,) = test_client.get("/api/projects", params={"flow": "shapefiles"}).json()["projects"]

    assert item["id"] == session_id
    assert item["flow"] == "shapefiles"
    for key in ("name", "stage", "import_profile", "updated_at", "blockers", "can_wait", "delivered_at"):
        assert item[key] is None, key
    assert item["changed_since_delivery"] is False
    assert datetime.fromisoformat(item["last_opened"]) == datetime.fromisoformat(meta["last_accessed"])
    assert item["expires_at"] is not None
    assert test_client.get(f"/api/projects/shapefiles/{session_id}").json() == item


def test_an_artwork_entry_without_project_json_lists(test_client) -> None:
    conversion_id = _conversion(test_client)
    directory = test_client.app.state.illustrator_store.root / conversion_id
    (directory / "project.json").unlink()

    (item,) = test_client.get("/api/projects", params={"flow": "artwork"}).json()["projects"]
    assert item["id"] == conversion_id
    assert item["name"] == "sample"
    assert item["stage"] == "name-floors"
    assert item["updated_at"] is None
    assert item["delivered_at"] is None

    (directory / "floors.json").write_text("[]", encoding="utf-8")
    assert test_client.get(f"/api/projects/artwork/{conversion_id}").json()["stage"] == "place"


def test_an_entry_deleted_mid_listing_is_skipped(test_client, monkeypatch) -> None:
    kept, doomed = _conversion(test_client), _conversion(test_client)
    store: ConversionStore = test_client.app.state.illustrator_store
    real_summarise = ConversionStore._summarise

    def vanishing(self, directory: Path):
        if directory.name == doomed:
            shutil.rmtree(directory)
        return real_summarise(self, directory)

    monkeypatch.setattr(ConversionStore, "_summarise", vanishing)

    body = test_client.get("/api/projects").json()

    assert [item["id"] for item in body["projects"]] == [kept]
    assert body["total"] == 1
    assert not (store.root / doomed).exists()


def test_concurrent_saves_during_listing_do_not_break_it(test_client, sample_dir: Path) -> None:
    session_ids = [_session(test_client, sample_dir) for _ in range(2)]
    manager: SessionManager = test_client.app.state.session_manager
    records = [manager.get_session(session_id, touch=False) for session_id in session_ids]
    stop = threading.Event()
    errors: list[BaseException] = []

    def save_repeatedly() -> None:
        try:
            while not stop.is_set():
                for record in records:
                    manager.save_session(record)
                    ghost = record.model_copy(update={"session_id": str(uuid4())})
                    manager.backend.save(ghost)
                    manager.backend.delete(ghost.session_id)
        except BaseException as exc:
            errors.append(exc)

    writer = threading.Thread(target=save_repeatedly)
    writer.start()
    try:
        for _ in range(40):
            response = test_client.get("/api/projects", params={"flow": "shapefiles"})
            assert response.status_code == 200, response.text
            assert set(session_ids) <= {item["id"] for item in response.json()["projects"]}
    finally:
        stop.set()
        writer.join()
    assert errors == []
