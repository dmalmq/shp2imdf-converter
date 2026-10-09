"""Layer files read back by Esri's own deserializer: they parse, and the new fills are what it reads.

Both the rewritten kind and the kind generated beside a shapefile. The
deserializer proves ArcGIS Pro can parse a document. It opens no data and
draws nothing, so whether Pro finds the shapefile and draws it is not shown here.
"""

from __future__ import annotations

from pathlib import Path
import subprocess

import pytest

from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert
from backend.tests.color_theme_fixtures import LAYER_FILE, SPACE_FIELDS, make_dbf, read_zip, space_row, square_shapefile
from backend.tests.esri_cim import AVAILABLE, SKIP_REASON, esri_read

pytestmark = [pytest.mark.colortheme, pytest.mark.skipif(not AVAILABLE, reason=SKIP_REASON)]

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"

# label -> fill, typed out from the Figma New table.
FILLS = [
    ("改札外通路 (Mono 000)", "#FFFFFF"),
    ("在来線改札内 (PaleBlue 050)", "#F2F7FB"),
    ("新幹線改札内 (PaleBlue 100)", "#E5EFF7"),
    ("施設 (Turquoise 150)", "#DDEBEC"),
    ("進入制限エリア (Mono 050)", "#F2F2F2"),
    ("階段・エスカレーター (Mono 000)", "#FFFFFF"),
]


def _rewritten(tmp_path: Path) -> Path:
    theme = load_color_theme(CONFIG)
    output = read_zip(convert(theme, [("a.lyrx", LAYER_FILE.read_bytes())], max_bytes=1 << 26).data)
    path = tmp_path / "a.lyrx"
    path.write_bytes(output["a.lyrx"])
    return path


def test_esri_reads_the_six_new_fills_and_the_outline_back(tmp_path: Path) -> None:
    read = esri_read(_rewritten(tmp_path))

    ((layer),) = read["layers"]
    assert (layer["name"], layer["fields"]) == ("DemoSta_0_Space", ["color2"])
    assert [(cls["label"], cls["fill"]) for cls in layer["classes"]] == FILLS
    assert {cls["stroke"] for cls in layer["classes"]} == {"#657678"}
    assert {tuple(cls["layers"]) for cls in layer["classes"]} == {("CIMSolidStroke", "CIMSolidFill")}
    assert layer["classes"][1]["values"] == ["在来線改札内", "黄", "薄紅"]


def test_esri_rejects_a_document_it_cannot_read(tmp_path: Path) -> None:
    path = _rewritten(tmp_path)
    path.write_text(path.read_text(encoding="utf-8").replace('"CIMUniqueValueClass"', '"CIMUniqueValueClassX"'), encoding="utf-8")

    with pytest.raises(subprocess.CalledProcessError):
        esri_read(path)


def _generated(tmp_path: Path, stem: str, dbf: bytes) -> Path:
    shp, shx = square_shapefile(1)
    upload = [(f"{stem}.shp", shp), (f"{stem}.shx", shx), (f"{stem}.dbf", dbf), (f"{stem}.cpg", b"UTF-8")]
    output = read_zip(convert(load_color_theme(CONFIG), upload, max_bytes=1 << 26, style_files=True).data)
    path = tmp_path / f"{stem}.lyrx"
    path.write_bytes(output[f"{stem}.lyrx"])
    return path


def test_esri_reads_a_generated_color2_layer_file_with_its_classes_fills_and_source(tmp_path: Path) -> None:
    read = esri_read(_generated(tmp_path, "DemoSta_1_Space", make_dbf(SPACE_FIELDS, [space_row("黄", "B999")])))

    ((layer),) = read["layers"]
    assert (layer["name"], layer["fields"]) == ("DemoSta_1_Space", ["color2"])
    assert [(cls["label"], cls["fill"]) for cls in layer["classes"]] == FILLS
    assert {cls["stroke"] for cls in layer["classes"]} == {"#657678"}
    assert {tuple(cls["layers"]) for cls in layer["classes"]} == {("CIMSolidStroke", "CIMSolidFill")}
    assert layer["classes"][2]["values"] == ["新幹線改札内", "橙", "緑", "濃紅"]
    assert layer["other"] == {"used": True, "label": "その他 (Other)", "fill": "#D9D9D9", "stroke": "#657678"}
    assert layer["source"] == {
        "type": "CIMStandardDataConnection",
        "factory": "Shapefile",
        "workspace": "DATABASE=.",
        "dataset": "DemoSta_1_Space.shp",
        "kind": "esriDTFeatureClass",
    }


def test_esri_reads_a_generated_category_layer_file_with_the_category_tables_classes(tmp_path: Path) -> None:
    unit = make_dbf([("name", "C", 20, 0), ("category", "C", 20, 0)], [[b"room", b"walkway"]])

    read = esri_read(_generated(tmp_path, "DemoSta_1_unit", unit), "category")

    ((layer),) = read["layers"]
    assert layer["fields"] == ["category"]
    assert [(cls["label"], cls["fill"], len(cls["values"])) for cls in layer["classes"]] == [
        ("改札外通路 (Mono 000)", "#FFFFFF", 3),
        ("在来線改札内 (PaleBlue 050)", "#F2F7FB", 3),
        ("施設 (Turquoise 150)", "#DDEBEC", 11),
        ("進入制限エリア (Mono 050)", "#F2F2F2", 9),
        ("階段・エスカレーター (Mono 000)", "#FFFFFF", 3),
    ]
    assert layer["classes"][4]["values"] == ["stairs", "escalator", "opentobelow"]
    assert layer["other"]["fill"] == "#D9D9D9"
