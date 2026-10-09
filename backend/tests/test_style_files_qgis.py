"""A downloaded style file, judged by QGIS itself.

``test_style_files.py`` reads the ``.qml`` as XML, which is how a file that
names the right colours and still draws nothing would pass. Here the real
QGIS opens the downloaded shapefile, finds the style beside it without being
told, and says which symbol each feature gets. Skipped where QGIS is not
installed; the rest of the suite never starts it.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any

import pytest

from backend.src import qgis_export
from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert
from backend.tests.color_theme_fixtures import SPACE_FIELDS, make_dbf, read_zip, space_row, square_shapefile

pytestmark = pytest.mark.colortheme

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
PROBE = Path(__file__).with_name("qgis_style_probe.py")
OUTLINE = {"layer": "SimpleFill", "outline": "#657678", "width": 0.5, "unit": "Point"}
OTHER = "#D9D9D9"

# A row's color2 as uploaded, and the fill QGIS must draw it in once converted. 濃鼠 B008 is a toilet the
# conversion rewrites to 施設; 赤 and the blank are values the theme does not know.
SPACE_ROWS = [
    ("黄", "B999", "#F2F7FB"),
    ("橙", "B999", "#E5EFF7"),
    ("ラチ外白", "B999", "#FFFFFF"),
    ("薄空", "B001", "#DDEBEC"),
    ("薄鼠", "B022", "#F2F2F2"),
    ("白", "B021", "#FFFFFF"),
    ("濃鼠", "B008", "#DDEBEC"),
    ("施設", "B001", "#DDEBEC"),
    ("赤", "B019", OTHER),
    ("", "B019", OTHER),
]
SPACE_CATEGORIES = [
    ("改札外通路 (Mono 000)", "#FFFFFF", ["改札外通路", "ラチ外白", "濃鼠", "道白"]),
    ("在来線改札内 (PaleBlue 050)", "#F2F7FB", ["在来線改札内", "黄", "薄紅"]),
    ("新幹線改札内 (PaleBlue 100)", "#E5EFF7", ["新幹線改札内", "橙", "緑", "濃紅"]),
    ("施設 (Turquoise 150)", "#DDEBEC", ["施設", "薄空", "濃空", "トイレ"]),
    ("進入制限エリア (Mono 050)", "#F2F2F2", ["進入制限エリア", "薄鼠", "進入制限あり"]),
    ("階段・エスカレーター (Mono 000)", "#FFFFFF", ["階段・エスカレーター", "白"]),
    ("その他 (Other)", OTHER, [""]),
]
UNIT_ROWS = [
    ("walkway", "#FFFFFF"),
    ("platform", "#F2F7FB"),
    ("restroom.male", "#DDEBEC"),
    ("elevator", "#F2F2F2"),
    ("escalator", "#FFFFFF"),
    ("vegetation", OTHER),
]
UNIT_CATEGORIES = [
    ("改札外通路 (Mono 000)", "#FFFFFF", 3),
    ("在来線改札内 (PaleBlue 050)", "#F2F7FB", 3),
    ("施設 (Turquoise 150)", "#DDEBEC", 11),
    ("進入制限エリア (Mono 050)", "#F2F2F2", 9),
    ("階段・エスカレーター (Mono 000)", "#FFFFFF", 3),
    ("その他 (Other)", OTHER, 1),
]


def _layer(stem: str, dbf: bytes, features: int) -> list[tuple[str, bytes]]:
    shp, shx = square_shapefile(features)
    return [(f"{stem}.shp", shp), (f"{stem}.shx", shx), (f"{stem}.dbf", dbf), (f"{stem}.cpg", b"UTF-8")]


@pytest.fixture(scope="module")
def qgis_read(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """What QGIS makes of a converted download unpacked into an empty folder, per shapefile name."""
    qgis_python = qgis_export._resolve_qgis_python()
    if not qgis_python or not Path(qgis_python).exists():
        pytest.skip("QGIS is not installed on this machine")
    prefix = Path(qgis_python).parent.parent / "apps" / "qgis"
    if not prefix.exists():
        pytest.skip(f"QGIS prefix not found at {prefix}")

    space = make_dbf(SPACE_FIELDS, [space_row(value, category) for value, category, _ in SPACE_ROWS])
    unit = make_dbf([("name", "C", 20, 0), ("category", "C", 20, 0)], [[b"room", category.encode()] for category, _ in UNIT_ROWS])
    upload = [*_layer("st/1_Space", space, len(SPACE_ROWS)), *_layer("st/1_unit", unit, len(UNIT_ROWS))]
    archive = convert(load_color_theme(CONFIG), upload, max_bytes=1 << 26, style_files=True)
    folder = tmp_path_factory.mktemp("download")
    for name, data in read_zip(archive.data).items():
        target = folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    out = folder / "probe.json"
    layers = [folder / "st" / "1_Space.shp", folder / "st" / "1_unit.shp"]
    done = subprocess.run(
        [qgis_python, str(PROBE), str(prefix), str(out), *map(str, layers)], capture_output=True, text=True, timeout=300
    )
    assert out.exists(), f"the probe wrote no verdict.\nstdout:\n{done.stdout}\nstderr:\n{done.stderr}"
    read = json.loads(out.read_text(encoding="utf-8"))
    return {Path(path).name: described for path, described in read.items()}


def test_qgis_draws_a_color2_layer_categorized_in_the_theme_fills_and_outline(qgis_read: dict[str, Any]) -> None:
    layer = qgis_read["1_Space.shp"]

    assert (layer["valid"], layer["renderer"], layer["field"]) == (True, "categorizedSymbol", "color2")
    assert [(item["label"], item["fill"], item["values"]) for item in layer["categories"]] == SPACE_CATEGORIES
    assert all({key: item[key] for key in OUTLINE} == OUTLINE for item in layer["categories"])


def test_qgis_gives_each_feature_the_fill_of_its_area_and_draws_unknown_values_as_other(qgis_read: dict[str, Any]) -> None:
    converted_values = ["在来線改札内", "新幹線改札内", "改札外通路", "施設", "進入制限エリア", "階段・エスカレーター", "施設", "施設", "赤", None]

    features = qgis_read["1_Space.shp"]["features"]

    assert [feature["value"] for feature in features] == converted_values
    assert [feature["fill"] for feature in features] == [fill for _, _, fill in SPACE_ROWS]


def test_qgis_draws_a_category_layer_by_the_category_table(qgis_read: dict[str, Any]) -> None:
    layer = qgis_read["1_unit.shp"]

    assert (layer["valid"], layer["renderer"], layer["field"]) == (True, "categorizedSymbol", "category")
    assert [(item["label"], item["fill"], len(item["values"])) for item in layer["categories"]] == UNIT_CATEGORIES
    assert all({key: item[key] for key in OUTLINE} == OUTLINE for item in layer["categories"])
    assert [(feature["value"], feature["fill"]) for feature in layer["features"]] == UNIT_ROWS
