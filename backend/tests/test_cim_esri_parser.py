"""A rewritten layer file read back by Esri's own deserializer: it parses, and the six new fills are what it reads."""

from __future__ import annotations

from pathlib import Path
import subprocess

import pytest

from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert
from backend.tests.color_theme_fixtures import LAYER_FILE, read_zip
from backend.tests.esri_cim import AVAILABLE, SKIP_REASON, esri_read

pytestmark = [pytest.mark.colortheme, pytest.mark.skipif(not AVAILABLE, reason=SKIP_REASON)]

CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"

# label -> fill, typed out from the Figma New table.
FILLS = [
    ("改札外通路", "#FFFFFF"),
    ("在来線改札内", "#F2F7FB"),
    ("新幹線改札内", "#E5EFF7"),
    ("施設", "#DDEBEC"),
    ("進入制限エリア", "#F2F2F2"),
    ("階段・エスカレーター", "#FFFFFF"),
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
