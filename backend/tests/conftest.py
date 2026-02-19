"""Shared pytest fixtures."""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.tests.generate_fixtures import generate_fixtures


@pytest.fixture(scope="session")
def fixtures_root() -> Path:
    root = Path(__file__).parent / "fixtures"
    target = root / "tokyo_station" / "JRTokyoSta_B1_Space.shp"
    if not target.exists():
        generate_fixtures(root)
    return root


@pytest.fixture()
def sample_dir(fixtures_root: Path) -> Path:
    return fixtures_root / "tokyo_station"


@pytest.fixture()
def edge_case_dir(fixtures_root: Path) -> Path:
    return fixtures_root / "edge_cases"


@pytest.fixture()
def loaded_gdfs(sample_dir: Path) -> dict[str, gpd.GeoDataFrame]:
    loaded: dict[str, gpd.GeoDataFrame] = {}
    for path in sample_dir.glob("*.shp"):
        gdf = gpd.read_file(path)
        if gdf.crs:
            gdf = gdf.to_crs(epsg=4326)
        loaded[path.stem] = gdf
    return loaded


@pytest.fixture()
def sample_config() -> dict:
    payload = Path("backend/config/filename_keywords.json").read_text(encoding="utf-8")
    return json.loads(payload)


@pytest.fixture()
def sample_categories() -> dict:
    payload = Path("backend/config/unit_categories.json").read_text(encoding="utf-8")
    return json.loads(payload)


@pytest.fixture()
def sample_company_mappings() -> dict:
    payload = Path("backend/config/company_mappings.json").read_text(encoding="utf-8")
    return json.loads(payload)


@pytest.fixture()
def test_client() -> TestClient:
    with TestClient(app) as client:
        yield client
