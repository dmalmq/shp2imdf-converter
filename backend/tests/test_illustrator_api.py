"""Endpoint tests for the georeferencing flow."""

from __future__ import annotations

import io
import zipfile

import pytest

from backend.src.geocoding import GeocodeAddressParts, GeocodeMatch
from backend.tests.test_illustrator_import import _build_minimal_ai_pdf


def _preview(test_client):
    return test_client.post(
        "/api/convert/illustrator/preview",
        files=[("file", ("sample.ai", _build_minimal_ai_pdf(), "application/postscript"))],
    )


def _body(bounds):
    return {
        "floors": [
            {
                "label": "artwork",
                "transform": {
                    "artwork_anchor": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
                    "map_anchor": [139.700258, 35.690921],
                    "rotation_deg": 12.5,
                    "metres_per_point": 0.176389,
                    "working_crs": "EPSG:6677",
                },
            }
        ],
        "output_crs": "EPSG:6677",
        "formats": {"geopackage": True, "shapefile": True, "qgis": True},
    }


@pytest.mark.georef
def test_preview_returns_a_conversion_id_and_bounds(test_client) -> None:
    response = _preview(test_client)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["conversion_id"]
    assert len(payload["artwork_bounds"]) == 4
    assert payload["total_features"] >= 1
    assert payload["preview"]["type"] == "FeatureCollection"
    assert "JPR CS" in payload["suggested_crs_label"]


@pytest.mark.georef
def test_preview_rejects_a_non_pdf_upload(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator/preview",
        files=[("file", ("bad.ai", b"not a pdf", "application/postscript"))],
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_returns_a_zip_with_every_format(test_client) -> None:
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export",
        json=_body(payload["artwork_bounds"]),
    )
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
    assert any(n.endswith(".prj") for n in names)


@pytest.mark.georef
def test_export_with_an_unknown_id_is_404(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator/deadbeef/export", json=_body([0.0, 0.0, 100.0, 100.0])
    )
    assert response.status_code == 404
    assert response.json()["code"] == "CONVERSION_EXPIRED"


@pytest.mark.georef
def test_export_rejects_a_qgis_project_without_its_geopackage(test_client) -> None:
    payload = _preview(test_client).json()
    body = _body(payload["artwork_bounds"])
    body["formats"] = {"geopackage": False, "shapefile": False, "qgis": True}
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_rejects_a_non_positive_scale(test_client) -> None:
    payload = _preview(test_client).json()
    body = _body(payload["artwork_bounds"])
    body["floors"][0]["transform"]["metres_per_point"] = 0
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 422


@pytest.mark.georef
def test_geocode_endpoint_needs_no_session(test_client) -> None:
    class FakeGeocoder:
        def search(self, query: str, language: str, limit: int = 5) -> list[GeocodeMatch]:
            assert query == "新宿駅"
            return [
                GeocodeMatch(
                    display_name="新宿駅",
                    latitude=35.690921,
                    longitude=139.700258,
                    source="fake",
                    address=GeocodeAddressParts(locality="新宿区", province="JP-13"),
                )
            ]

        def reverse(self, latitude: float, longitude: float, language: str):
            return None

    test_client.app.state.geocoder = FakeGeocoder()
    response = test_client.get("/api/geocode", params={"query": "新宿駅", "language": "ja"})
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["longitude"] == pytest.approx(139.700258)
    assert results[0]["address"]["province"] == "JP-13"


@pytest.mark.georef
def test_geocode_reports_when_disabled(test_client) -> None:
    test_client.app.state.geocoder = None
    response = test_client.get("/api/geocode", params={"query": "新宿駅"})
    assert response.status_code == 503
    assert response.json()["code"] == "GEOCODER_DISABLED"


@pytest.mark.georef
def test_legacy_direct_download_endpoint_still_works(test_client) -> None:
    response = test_client.post(
        "/api/convert/illustrator",
        files=[("file", ("sample.ai", _build_minimal_ai_pdf(), "application/postscript"))],
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"


PLACEMENT_BODY = {
    "name": "Placement CRUD Test",
    "transform": {
        "artwork_anchor": [250.0, 275.0],
        "map_anchor": [139.700258, 35.690921],
        "rotation_deg": 12.5,
        "metres_per_point": 0.176389,
        "working_crs": "EPSG:6677",
    },
    "artwork_bounds": [0.0, 0.0, 500.0, 550.0],
}


@pytest.mark.georef
def test_placement_crud_round_trip(test_client) -> None:
    created = test_client.post("/api/placements", json=PLACEMENT_BODY)
    assert created.status_code == 201, created.text
    placement_id = created.json()["id"]
    try:
        listed = test_client.get("/api/placements").json()["placements"]
        assert any(p["id"] == placement_id for p in listed)

        changed = {
            **PLACEMENT_BODY,
            "transform": {**PLACEMENT_BODY["transform"], "rotation_deg": -3.0},
        }
        updated = test_client.put(f"/api/placements/{placement_id}", json=changed)
        assert updated.status_code == 200
        assert updated.json()["transform"]["rotation_deg"] == -3.0
    finally:
        assert test_client.delete(f"/api/placements/{placement_id}").status_code == 204


@pytest.mark.georef
def test_duplicate_placement_name_is_409(test_client) -> None:
    body = {**PLACEMENT_BODY, "name": "Duplicate Name Test"}
    first = test_client.post("/api/placements", json=body)
    assert first.status_code == 201
    try:
        conflict = test_client.post("/api/placements", json=body)
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "PLACEMENT_NAME_TAKEN"
    finally:
        test_client.delete(f"/api/placements/{first.json()['id']}")


@pytest.mark.georef
def test_deleting_an_unknown_placement_is_404(test_client) -> None:
    assert test_client.delete("/api/placements/999999").status_code == 404


def _assign_body():
    return {
        "floors": [
            {"label": "1F", "box": [0.0, 0.0, 85.0, 200.0], "layer_names": None},
            {"label": "2F", "box": [85.0, 0.0, 200.0, 200.0], "layer_names": None},
        ]
    }


@pytest.mark.georef
def test_assign_returns_per_floor_counts(test_client) -> None:
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign",
        json=_assign_body(),
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert {floor["label"] for floor in data["floors"]} == {"1F", "2F"}
    assert data["total_features"] == payload["total_features"]
    assert data["unassigned_count"] + sum(
        floor["feature_count"] for floor in data["floors"]
    ) == data["total_features"]


@pytest.mark.georef
def test_assign_rejects_duplicate_labels(test_client) -> None:
    payload = _preview(test_client).json()
    body = _assign_body()
    body["floors"][1]["label"] = "1F"
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=body
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_assign_rejects_unknown_layers(test_client) -> None:
    payload = _preview(test_client).json()
    body = _assign_body()
    body["floors"][0]["layer_names"] = ["存在しない層"]
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=body
    )
    assert response.status_code == 400


@pytest.mark.georef
def test_export_after_assignment_requires_all_floors(test_client) -> None:
    payload = _preview(test_client).json()
    assert test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=_assign_body()
    ).status_code == 200
    bounds = payload["artwork_bounds"]
    body = _body(bounds)
    body["floors"] = body["floors"][:1]
    body["floors"][0]["label"] = "1F"
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 422
    assert response.json()["code"] == "FLOOR_MISMATCH"


@pytest.mark.georef
def test_export_after_assignment_with_all_floors_succeeds(test_client) -> None:
    payload = _preview(test_client).json()
    assert test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/assign", json=_assign_body()
    ).status_code == 200
    bounds = payload["artwork_bounds"]
    body = _body(bounds)
    body["floors"] = [
        {"label": label, "transform": body["floors"][0]["transform"]}
        for label in ("1F", "2F")
    ]
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export", json=body
    )
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert "export_report.json" in names


@pytest.mark.georef
def test_export_without_assignment_still_works_single_floor(test_client) -> None:
    """Backward compatibility: one implicit floor, no assign call."""
    payload = _preview(test_client).json()
    response = test_client.post(
        f"/api/convert/illustrator/{payload['conversion_id']}/export",
        json=_body(payload["artwork_bounds"]),
    )
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
    assert any(n.endswith(".gpkg") for n in names)
    assert any(n.endswith(".qgs") for n in names)
    assert "export_report.json" in names
