"""Vector tile builds over HTTP, end to end, with ``fake_tile_worker.py`` standing in for arcpy.

The real ``build_tiles.py`` needs a licensed ArcGIS Pro and has not been run
here; everything around it has: refusals, the queue, status, the download.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import zipfile
from io import BytesIO

import pytest

from backend.src.arcgis_pro import ArcpyAvailable, ArcpyChecking, ArcpyUnavailable
from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert
from backend.src.tile_jobs import TileJobs
from backend.tests.color_theme_fixtures import make_zip, station_members, tile_project, tile_uri

pytestmark = [pytest.mark.colortheme, pytest.mark.vectortiles]

FAKE = Path(__file__).with_name("fake_tile_worker.py")
CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
PROJECT = "東京/ArcProPrj/東京.aprx"


def _upload(plan: dict, *, projects: tuple[str, ...] = (PROJECT,), maps: tuple[str, ...] = ("Stenavi",)) -> bytes:
    members = station_members() + [(path, tile_project(plan, maps=maps)) for path in projects]
    return make_zip(members)


def _post(client, payload: bytes, **flags: str):
    return client.post(
        "/api/color-theme/convert", files=[("files", ("東京.zip", payload, "application/zip"))], data=flags
    )


@pytest.fixture()
def jobs(test_client, tmp_path) -> TileJobs:
    """A server whose arcpy is licensed and whose worker is the fake."""
    state = test_client.app.state
    state.arcpy = SimpleNamespace(status=ArcpyAvailable(product="ArcInfo", python=Path(sys.executable)))
    state.tile_jobs = TileJobs(tmp_path / "j", ttl_seconds=3600, script=FAKE)
    return state.tile_jobs


def _wait(client, job_id: str, until) -> dict:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status = client.get(f"/api/color-theme/jobs/{job_id}").json()
        if until(status):
            return status
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} stuck at {status}")


def _finished(status: dict) -> bool:
    return status["state"] in ("done", "failed")


def test_without_the_flag_convert_answers_exactly_as_before(test_client, jobs) -> None:
    payload = _upload({})
    expected = convert(load_color_theme(CONFIG), [("東京.zip", payload)], max_bytes=1 << 30).data

    absent = _post(test_client, payload)
    off = _post(test_client, payload, vector_tiles="false")

    assert absent.status_code == off.status_code == 200
    assert absent.headers["content-type"] == "application/zip"
    assert absent.content == off.content == expected
    assert list(jobs.root.iterdir()) == []


@pytest.mark.parametrize(
    "status, detail",
    [
        (ArcpyUnavailable(reason="not_licensed", detail="arcpy.ProductInfo() is NotInitialized"), "NotInitialized"),
        (ArcpyChecking(), "still being checked"),
    ],
)
def test_without_a_licensed_arcpy_a_build_is_refused(test_client, jobs, status, detail) -> None:
    test_client.app.state.arcpy = SimpleNamespace(status=status)

    response = _post(test_client, _upload({}), vector_tiles="true")

    assert response.status_code == 409
    assert response.json()["code"] == "VECTOR_TILES_UNAVAILABLE"
    assert detail in response.json()["detail"]
    assert list(jobs.root.iterdir()) == []


@pytest.mark.parametrize("projects", [(), (PROJECT, "東京/other.aprx")])
def test_a_build_needs_exactly_one_project(test_client, jobs, projects) -> None:
    response = _post(test_client, _upload({}, projects=projects), vector_tiles="true")

    assert response.status_code == 400
    assert response.json()["code"] == "VECTOR_TILES_NEED_ONE_PROJECT"
    assert f"this upload has {len(projects)}" in response.json()["detail"]
    assert list(jobs.root.iterdir()) == []


def test_the_server_reports_whether_it_can_build(test_client) -> None:
    test_client.app.state.arcpy = SimpleNamespace(status=ArcpyUnavailable(reason="not_licensed", detail="x"))
    assert test_client.get("/api/color-theme/vector-tiles").json() == {
        "state": "unavailable",
        "reason": "not_licensed",
        "detail": "x",
    }

    test_client.app.state.arcpy = SimpleNamespace(status=ArcpyAvailable(product="ArcView", python=Path("p.exe")))
    assert test_client.get("/api/color-theme/vector-tiles").json() == {"state": "available", "product": "ArcView"}


def test_builds_run_one_at_a_time_and_download_the_conversion_plus_tiles(test_client, jobs, tmp_path) -> None:
    gate = tmp_path / "gate"
    payload = _upload({"gate": str(gate), "expects": ["東京/0/Space.dbf", "東京/station.qmd"]})
    converted = convert(load_color_theme(CONFIG), [("東京.zip", payload)], max_bytes=1 << 30, style_files=True)

    first = _post(test_client, payload, vector_tiles="true", style_files="true")
    second = _post(test_client, payload, vector_tiles="true", style_files="true")

    assert first.status_code == second.status_code == 202
    first_id, second_id = first.json()["job_id"], second.json()["job_id"]
    running = _wait(test_client, first_id, lambda status: status["state"] == "running" and status["step"] == 1)
    assert running == {"state": "running", "step": 1, "of": 5, "label": "Create Vector Tile Index (5000 vertices)"}
    assert test_client.get(f"/api/color-theme/jobs/{second_id}").json() == {"state": "queued", "position": 1}
    unfinished = test_client.get(f"/api/color-theme/jobs/{first_id}/download")
    assert unfinished.status_code == 409

    gate.touch()
    done = _wait(test_client, first_id, _finished)
    assert done == {
        "state": "done",
        "filename": "東京_new-colors.zip",
        "warnings": ["These groups have no layer chosen and are switched off: ordinal_-1, WiFi"],
        "problems": [],
    }
    assert _wait(test_client, second_id, _finished)["state"] == "done"

    response = test_client.get(f"/api/color-theme/jobs/{first_id}/download")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert "filename*=utf-8''" in response.headers["content-disposition"].lower()
    with zipfile.ZipFile(BytesIO(converted.data)) as want, zipfile.ZipFile(BytesIO(response.content)) as got:
        expected = [(info.filename, info.date_time, want.read(info)) for info in want.infolist()]
        entries = got.infolist()
        assert [(info.filename, info.date_time, got.read(info)) for info in entries[: len(expected)]] == expected
        added = {info.filename: got.read(info) for info in entries[len(expected) :]}
    tiles = "vector_tiles/東京.vtiles/"
    assert sorted(added) == sorted(
        [f"{tiles}resources/styles/root.json", "vector_tiles/build_log.txt"]
        + [f"{tiles}tile/{z}/0/0.pbf" for z in range(15, 22)]
    )
    assert added[f"{tiles}tile/21/0/0.pbf"] == bytes([21]) * 3
    log = added["vector_tiles/build_log.txt"].decode("utf-8")
    assert "[1/5] Create Vector Tile Index (5000 vertices)" in log
    assert "WARNING: These groups have no layer chosen and are switched off: ordinal_-1, WiFi" in log
    assert "arcpy prose that is not JSON" in log


def test_a_failed_build_reports_the_worker_reason(test_client, jobs) -> None:
    response = _post(test_client, _upload({"fail": "ERROR 000732: Input Map: Dataset does not exist"}), vector_tiles="true")

    job_id = response.json()["job_id"]
    status = _wait(test_client, job_id, _finished)
    assert status == {"state": "failed", "reason": "ERROR 000732: Input Map: Dataset does not exist"}
    assert test_client.get(f"/api/color-theme/jobs/{job_id}/download").status_code == 409
    log = (jobs.root / job_id / "build_log.txt").read_text(encoding="utf-8")
    assert "stderr: Traceback: something arcpy said" in log
    assert sorted(path.name for path in (jobs.root / job_id).iterdir()) == ["build_log.txt"]


def test_a_build_past_its_timeout_is_stopped(test_client, tmp_path) -> None:
    state = test_client.app.state
    state.arcpy = SimpleNamespace(status=ArcpyAvailable(product="ArcInfo", python=Path(sys.executable)))
    state.tile_jobs = TileJobs(tmp_path / "j", ttl_seconds=3600, script=FAKE, timeout_seconds=1)

    job_id = _post(test_client, _upload({"hang": True}), vector_tiles="true").json()["job_id"]

    assert _wait(test_client, job_id, _finished) == {
        "state": "failed",
        "reason": "The build was stopped after running for 0:00:01 (h:mm:ss).",
    }


def test_an_unknown_or_expired_job_is_not_found(test_client, tmp_path) -> None:
    state = test_client.app.state
    state.arcpy = SimpleNamespace(status=ArcpyAvailable(product="ArcInfo", python=Path(sys.executable)))
    state.tile_jobs = jobs = TileJobs(tmp_path / "j", ttl_seconds=0, script=FAKE)
    job_id = _post(test_client, _upload({}), vector_tiles="true").json()["job_id"]
    _wait(test_client, job_id, _finished)

    jobs.prune()

    for path in (f"/api/color-theme/jobs/{job_id}", f"/api/color-theme/jobs/{job_id}/download", "/api/color-theme/jobs/nope"):
        response = test_client.get(path)
        assert response.status_code == 404
        assert response.json()["code"] == "TILE_JOB_NOT_FOUND"
    assert list(jobs.root.iterdir()) == []


def _log(client, job_id: str) -> str:
    assert _wait(client, job_id, _finished)["state"] == "done"
    download = client.get(f"/api/color-theme/jobs/{job_id}/download").content
    with zipfile.ZipFile(BytesIO(download)) as got:
        return got.read("vector_tiles/build_log.txt").decode("utf-8")


def test_without_a_choice_the_build_tiles_the_projects_defaults(test_client, jobs) -> None:
    response = _post(test_client, _upload({}), vector_tiles="true")

    assert response.status_code == 202, response.text
    assert "Tiled: ordinal_1\\JRSta_1F\\JRSta_1_Space, 背景\r\n" in _log(test_client, response.json()["job_id"])


def test_the_chosen_layers_are_what_the_worker_is_told_to_tile(test_client, jobs) -> None:
    chosen = [tile_uri("JRSta_B1_Space"), tile_uri("Facility_Merge_1")]

    response = _post(test_client, _upload({}), vector_tiles="true", tile_layers=json.dumps(chosen))

    assert response.status_code == 202, response.text
    log = _log(test_client, response.json()["job_id"])
    assert "Tiled: ordinal_1\\Facility_Merge_1, ordinal_-1\\JRSta_B1_Space\r\n" in log
    assert "WARNING: These groups have no layer chosen and are switched off: ordinal_1\\JRSta_1F, WiFi" in log


@pytest.mark.parametrize(
    "tile_layers, code, detail",
    [
        (json.dumps([tile_uri("背景"), "CIMPATH=stenavi/gone.json"]), "VECTOR_TILES_BAD_LAYERS", "CIMPATH=stenavi/gone.json"),
        (json.dumps([tile_uri("ordinal_1")]), "VECTOR_TILES_BAD_LAYERS", "not groups: ordinal_1"),
        (json.dumps([]), "VECTOR_TILES_BAD_LAYERS", "at least one layer"),
        ("CIMPATH=stenavi/a.json", "BAD_REQUEST", "JSON list"),
        (json.dumps({"layers": []}), "BAD_REQUEST", "JSON list"),
    ],
)
def test_a_choice_that_is_not_the_maps_layers_is_refused_before_a_job(test_client, jobs, tile_layers, code, detail) -> None:
    response = _post(test_client, _upload({}), vector_tiles="true", tile_layers=tile_layers)

    assert response.status_code == 400
    assert response.json()["code"] == code
    assert detail in response.json()["detail"]
    assert list(jobs.root.iterdir()) == []


def test_a_choice_without_a_build_is_refused(test_client, jobs) -> None:
    response = _post(test_client, _upload({}), tile_layers=json.dumps([tile_uri("背景")]))

    assert response.status_code == 400
    assert "only sent with vector_tiles=true" in response.json()["detail"]


def test_a_project_with_two_maps_is_refused_before_a_job(test_client, jobs) -> None:
    response = _post(test_client, _upload({}, maps=("1F", "B1")), vector_tiles="true")

    assert response.status_code == 400
    assert response.json()["code"] == "VECTOR_TILES_NEED_ONE_MAP"
    assert "has 2: 1F, B1" in response.json()["detail"]
    assert list(jobs.root.iterdir()) == []
