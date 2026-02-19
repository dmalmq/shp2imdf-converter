"""Phase 6 edge-case coverage."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from shapely.geometry import Polygon, mapping

from backend.src.schemas import CleanupSummary, ImportedFile
from backend.src.session import MemorySessionBackend, SessionManager


def _upload_payload(directory: Path, stem: str) -> list[tuple[str, tuple[str, bytes, str]]]:
  files: list[tuple[str, tuple[str, bytes, str]]] = []
  for path in directory.glob(f"{stem}.*"):
    files.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))
  return files


def _session_seed_feature(index: int) -> dict:
  x = float(index)
  geometry = Polygon(
    [
      (x, 0.0),
      (x + 0.8, 0.0),
      (x + 0.8, 0.8),
      (x, 0.8),
      (x, 0.0),
    ]
  )
  return {
    "type": "Feature",
    "id": str(uuid4()),
    "feature_type": "unit",
    "geometry": mapping(geometry),
    "properties": {
      "category": "unspecified",
      "status": "mapped",
      "issues": [],
      "level_id": "level-1",
      "name": {"en": f"Unit {index}"},
    },
  }


@pytest.mark.phase6
def test_import_missing_prj_reports_warning(test_client, edge_case_dir: Path) -> None:
  response = test_client.post("/api/import", files=_upload_payload(edge_case_dir, "no_prj_file"))
  assert response.status_code == 201
  payload = response.json()

  assert payload["warnings"]
  assert any("missing .prj" in warning.lower() for warning in payload["warnings"])
  assert payload["files"][0]["warnings"]


@pytest.mark.phase6
def test_import_empty_file_returns_zero_features(test_client, edge_case_dir: Path) -> None:
  response = test_client.post("/api/import", files=_upload_payload(edge_case_dir, "empty_file"))
  assert response.status_code == 201

  payload = response.json()
  assert payload["files"][0]["feature_count"] == 0

  session_id = payload["session_id"]
  feature_response = test_client.get(f"/api/session/{session_id}/features")
  assert feature_response.status_code == 200
  assert feature_response.json()["features"] == []


@pytest.mark.phase6
def test_import_mixed_geometry_file_is_handled(test_client, edge_case_dir: Path) -> None:
  response = test_client.post("/api/import", files=_upload_payload(edge_case_dir, "mixed_geometry"))
  assert response.status_code == 201
  payload = response.json()

  file_row = payload["files"][0]
  assert file_row["geometry_type"] in {"LineString", "Mixed"}
  assert file_row["feature_count"] > 0


@pytest.mark.phase6
def test_large_bulk_operations_patch_and_delete(test_client) -> None:
  manager = test_client.app.state.session_manager
  features = [_session_seed_feature(index) for index in range(250)]
  session = manager.create_session(
    files=[
      ImportedFile(
        stem="bulk_seed",
        geometry_type="Polygon",
        feature_count=len(features),
        attribute_columns=[],
        detected_type="unit",
        confidence="green",
      )
    ],
    cleanup_summary=CleanupSummary(),
    feature_collection={"type": "FeatureCollection", "features": features},
  )

  patch_ids = [feature["id"] for feature in features[:150]]
  patch_response = test_client.patch(
    f"/api/session/{session.session_id}/features/bulk",
    json={
      "feature_ids": patch_ids,
      "action": "patch",
      "properties": {"category": "office"},
    },
  )
  assert patch_response.status_code == 200
  assert patch_response.json()["updated_count"] == 150

  delete_ids = [feature["id"] for feature in features[150:200]]
  delete_response = test_client.patch(
    f"/api/session/{session.session_id}/features/bulk",
    json={"feature_ids": delete_ids, "action": "delete"},
  )
  assert delete_response.status_code == 200
  assert delete_response.json()["deleted_count"] == 50


@pytest.mark.phase6
def test_session_cleanup_prunes_expired_records() -> None:
  manager = SessionManager(backend=MemorySessionBackend(), ttl_hours=1, max_sessions=5)
  session = manager.create_session(
    files=[ImportedFile(stem="cleanup", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
    cleanup_summary=CleanupSummary(),
    feature_collection={"type": "FeatureCollection", "features": []},
  )

  record = manager.get_session(session.session_id, touch=False)
  assert record is not None
  record.last_accessed = datetime.now(UTC) - timedelta(hours=2)
  manager.backend.save(record)

  removed = manager.prune_expired()
  assert removed == 1
  assert manager.get_session(session.session_id) is None


@pytest.mark.phase6
def test_concurrent_session_limit_evicts_oldest() -> None:
  manager = SessionManager(backend=MemorySessionBackend(), ttl_hours=24, max_sessions=2)

  first = manager.create_session(
    files=[ImportedFile(stem="first", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
    cleanup_summary=CleanupSummary(),
    feature_collection={"type": "FeatureCollection", "features": []},
  )
  first_record = manager.get_session(first.session_id, touch=False)
  assert first_record is not None
  first_record.last_accessed = datetime.now(UTC) - timedelta(minutes=30)
  manager.backend.save(first_record)

  second = manager.create_session(
    files=[ImportedFile(stem="second", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
    cleanup_summary=CleanupSummary(),
    feature_collection={"type": "FeatureCollection", "features": []},
  )
  second_record = manager.get_session(second.session_id, touch=False)
  assert second_record is not None
  second_record.last_accessed = datetime.now(UTC) - timedelta(minutes=10)
  manager.backend.save(second_record)

  third = manager.create_session(
    files=[ImportedFile(stem="third", geometry_type="Polygon", feature_count=1, attribute_columns=[], confidence="green")],
    cleanup_summary=CleanupSummary(),
    feature_collection={"type": "FeatureCollection", "features": []},
  )

  assert manager.get_session(first.session_id, touch=False) is None
  assert manager.get_session(second.session_id, touch=False) is not None
  assert manager.get_session(third.session_id, touch=False) is not None
  assert len(manager.backend.list_all()) == 2
