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
        "transform": {
            "artwork_anchor": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            "map_anchor": [139.700258, 35.690921],
            "rotation_deg": 12.5,
            "metres_per_point": 0.176389,
            "working_crs": "EPSG:6677",
        },
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
    body["transform"]["metres_per_point"] = 0
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
