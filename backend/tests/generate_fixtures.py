"""Generate shapefile fixtures used by tests."""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
from shapely.geometry import LineString, MultiPolygon, Polygon


def _write_shapefile(path: Path, rows: list[dict], crs: str | None = "EPSG:3857") -> None:
    if rows:
        gdf = gpd.GeoDataFrame(rows, geometry="geometry", crs=crs)
    else:
        gdf = gpd.GeoDataFrame({"geometry": []}, geometry="geometry", crs=crs)
    path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(path)


def _tokyo_station(out_dir: Path) -> None:
    _write_shapefile(
        out_dir / "JRTokyoSta_B1_Space.shp",
        [
            {
                "NAME": "B1 Room A",
                "COMPANY_CODE": "SHOP",
                "geometry": Polygon(
                    [
                        (15500000, 4250000),
                        (15500030, 4250000),
                        (15500030, 4250030),
                        (15500000, 4250030),
                        (15500000, 4250000),
                    ]
                ),
            },
            {
                "NAME": "B1 Room B",
                "COMPANY_CODE": "FOOD",
                "geometry": Polygon(
                    [
                        (15500040, 4250000),
                        (15500075, 4250000),
                        (15500075, 4250030),
                        (15500040, 4250030),
                        (15500040, 4250000),
                    ]
                ),
            },
        ],
    )
    _write_shapefile(
        out_dir / "JRTokyoSta_B1_Opening.shp",
        [
            {
                "TYPE": "pedestrian",
                "geometry": LineString([(15500030, 4250010), (15500040, 4250010)]),
            }
        ],
    )
    _write_shapefile(
        out_dir / "JRTokyoSta_GF_Space.shp",
        [
            {
                "NAME": "GF Room A",
                "COMPANY_CODE": "OFFICE",
                "geometry": Polygon(
                    [
                        (15500000, 4250100),
                        (15500035, 4250100),
                        (15500035, 4250130),
                        (15500000, 4250130),
                        (15500000, 4250100),
                    ]
                ),
            }
        ],
    )


def _edge_cases(out_dir: Path) -> None:
    # Missing .prj case.
    no_prj_path = out_dir / "no_prj_file.shp"
    _write_shapefile(
        no_prj_path,
        [{"ID": 1, "geometry": Polygon([(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)])}],
    )
    prj = no_prj_path.with_suffix(".prj")
    if prj.exists():
        prj.unlink()

    # Empty shapefile.
    _write_shapefile(out_dir / "empty_file.shp", [])

    # Self-intersecting polygon.
    _write_shapefile(
        out_dir / "invalid_geometry.shp",
        [
            {
                "ID": 1,
                "geometry": Polygon([(0, 0), (5, 5), (5, 0), (0, 5), (0, 0)]),
            }
        ],
    )

    # Overlapping polygons.
    _write_shapefile(
        out_dir / "overlapping_units.shp",
        [
            {"ID": 1, "geometry": Polygon([(0, 0), (8, 0), (8, 8), (0, 8), (0, 0)])},
            {"ID": 2, "geometry": Polygon([(4, 4), (12, 4), (12, 12), (4, 12), (4, 4)])},
        ],
    )

    # MultiPolygon input.
    _write_shapefile(
        out_dir / "multipolygon_units.shp",
        [
            {
                "ID": 1,
                "geometry": MultiPolygon(
                    [
                        Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)]),
                        Polygon([(3, 3), (5, 3), (5, 5), (3, 5), (3, 3)]),
                    ]
                ),
            }
        ],
    )

    # Duplicate geometry.
    square = Polygon([(20, 20), (23, 20), (23, 23), (20, 23), (20, 20)])
    _write_shapefile(
        out_dir / "duplicate_geometry.shp",
        [{"ID": 1, "geometry": square}, {"ID": 2, "geometry": square}],
    )

    # Sliver.
    _write_shapefile(
        out_dir / "sliver_polygons.shp",
        [{"ID": 1, "geometry": Polygon([(30, 30), (30.1, 30), (30.1, 35), (30, 35), (30, 30)])}],
    )

    # Detached opening.
    _write_shapefile(
        out_dir / "detached_opening.shp",
        [{"ID": 1, "geometry": LineString([(100, 100), (102, 102)])}],
    )

    # Flipped coordinates style sample.
    _write_shapefile(
        out_dir / "flipped_coordinates.shp",
        [
            {
                "ID": 1,
                "geometry": Polygon([(35.68, 139.76), (35.69, 139.76), (35.69, 139.77), (35.68, 139.77), (35.68, 139.76)]),
            }
        ],
        crs="EPSG:4326",
    )

    # Mixed geometry approximation via lines for import tolerance.
    _write_shapefile(
        out_dir / "mixed_geometry.shp",
        [
            {"ID": 1, "geometry": LineString([(0, 0), (1, 1)])},
            {"ID": 2, "geometry": LineString([(1, 0), (2, 1)])},
        ],
    )


def generate_fixtures(base_dir: str | Path) -> None:
    root = Path(base_dir)
    tokyo_dir = root / "tokyo_station"
    edge_dir = root / "edge_cases"
    _tokyo_station(tokyo_dir)
    _edge_cases(edge_dir)


if __name__ == "__main__":
    fixtures_root = Path(__file__).parent / "fixtures"
    generate_fixtures(fixtures_root)
    print(f"Fixtures generated in {fixtures_root}")

