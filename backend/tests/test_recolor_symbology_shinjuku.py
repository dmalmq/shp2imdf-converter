"""The real Shinjuku station project, rethemed on a copy: its 58 unit layers, coloured by category, are redrawn in
the five areas they hold, and its fixture layers and every other member come back unchanged.

The project is not in the repository. Set ``SHINJUKU_APRX`` to an ``.aprx``
saved by Pro from the Shinjuku station data; the test copies it first.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil

import pytest

from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import read_zip, zip_members
from backend.tests.esri_cim import AVAILABLE, esri_read

SHINJUKU = Path(os.getenv("SHINJUKU_APRX", "")) if os.getenv("SHINJUKU_APRX") else None
CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 1024 * 1024 * 1024
OUTLINE = "#657678"

# What a unit layer draws afterwards, typed out from the operator-approved table: label, fill, and the categories
# in the order the layer lists them. vegetation is in no area and keeps its own green.
UNIT_CLASSES = [
    ("改札外通路 (Mono 000)", "#FFFFFF", ["ramp", "road", "walkway"]),
    ("在来線改札内 (PaleBlue 050)", "#F2F7FB", ["platform", "ramp_sta", "walkway_sta"]),
    (
        "施設 (Turquoise 150)",
        "#DDEBEC",
        [
            "ATM",
            "accessible restroom",
            "clinic",
            "pharmacy",
            "restroom.female",
            "restroom.male",
            "restroom.wheelchair",
            "store",
            "store_sta",
            "theater",
            "ticket office",
        ],
    ),
    (
        "進入制限エリア (Mono 050)",
        "#F2F2F2",
        [
            "auditorium",
            "elevator",
            "information desk",
            "mothersroom",
            "nonpublic",
            "smokingarea",
            "unenclosedarea",
            "unspecified",
            "waitingroom",
        ],
    ),
    ("階段・エスカレーター (Mono 000)", "#FFFFFF", ["escalator", "opentobelow", "stairs"]),
    ("vegetation", "#96CB91", ["vegetation"]),
]

pytestmark = [
    pytest.mark.colortheme,
    pytest.mark.skipif(SHINJUKU is None or not SHINJUKU.is_file(), reason="set SHINJUKU_APRX to the Shinjuku station project"),
]


def _hex(colour: dict) -> str:
    return "#" + "".join(f"{int(channel):02X}" for channel in colour["values"][:3])


def _drawn(layer: dict) -> list[tuple[str, str, list[str]]]:
    drawn = []
    for group in layer["renderer"]["groups"]:
        for cls in group["classes"]:
            (fill,) = [item for item in cls["symbol"]["symbol"]["symbolLayers"] if item["type"] == "CIMSolidFill"]
            drawn.append((cls["label"], _hex(fill["color"]), [value["fieldValues"][0] for value in cls["values"]]))
    return drawn


def _outlines(layer: dict) -> list[str]:
    return [
        _hex(item["color"])
        for group in layer["renderer"]["groups"]
        for cls in group["classes"]
        for item in cls["symbol"]["symbol"]["symbolLayers"]
        if item["type"] == "CIMSolidStroke"
    ]


def _without_groups(layer: dict) -> dict:
    return {**layer, "renderer": {key: value for key, value in layer["renderer"].items() if key != "groups"}}


def test_shinjuku_project_has_its_58_unit_layers_redrawn_by_area_and_nothing_else(tmp_path: Path) -> None:
    assert SHINJUKU is not None
    theme = load_color_theme(CONFIG)
    source = shutil.copyfile(SHINJUKU, tmp_path / "shinjuku.aprx").read_bytes()
    upload = [("shinjuku.aprx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    archive = convert(theme, upload, max_bytes=LIMIT)

    ((line),) = report.symbology
    assert (line.kind, line.unreadable) == ("aprx", False)
    assert len(line.renderers) == 58
    assert {(r.field, r.outcome, r.classes_before, r.classes_after, r.kept, r.areas) for r in line.renderers} == {
        (
            "category",
            "rewritten",
            30,
            6,
            ("vegetation",),
            ("free_area", "paid_area", "facilities", "restricted", "stairs_escalators"),
        )
    }
    assert all(r.layer is not None and r.layer.endswith("_unit") for r in line.renderers)

    output = read_zip(archive.data)["shinjuku.aprx"]
    before, after = zip_members(source), zip_members(output)
    assert len(before) == len(after) == 894
    assert [m[:3] for m in after] == [m[:3] for m in before]
    changed = [(old, new) for old, new in zip(before, after) if old != new]
    unchanged = [new[0] for old, new in zip(before, after) if old == new]
    assert (len(changed), len(unchanged)) == (58, 836)
    assert len([name for name in unchanged if name.endswith("_fixture.json")]) == 6
    for old, new in changed:
        old_layer, new_layer = json.loads(old[4]), json.loads(new[4])
        assert new[0].endswith("_unit.json")
        assert _drawn(new_layer) == UNIT_CLASSES, new[0]
        assert _outlines(new_layer) == [OUTLINE] * 5 + ["#C8C9CA"], new[0]
        assert _without_groups(new_layer) == _without_groups(old_layer), new[0]

    if AVAILABLE:
        path = tmp_path / "shinjuku_new.aprx"
        path.write_bytes(output)
        read = esri_read(path, "category")
        assert read["failed"] == []
        units = [layer for layer in read["layers"] if layer["name"].endswith("_unit")]
        fixtures = [layer for layer in read["layers"] if layer["name"].endswith("_fixture")]
        assert (len(units), len(fixtures), len(read["layers"])) == (58, 6, 64)
        assert {tuple((cls["label"], cls["fill"], tuple(cls["values"])) for cls in layer["classes"]) for layer in units} == {
            tuple((label, fill, tuple(values)) for label, fill, values in UNIT_CLASSES)
        }
        assert {tuple(cls["stroke"] for cls in layer["classes"]) for layer in units} == {(*[OUTLINE] * 5, "#C8C9CA")}
        assert {cls["fill"] for layer in fixtures for cls in layer["classes"]} == {"#E54A1A"}

    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT).theme
    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT)
    assert {(r.field, r.outcome) for r in rerun.symbology[0].renderers} == {("category", "already_new")}
    assert len(rerun.symbology[0].renderers) == 58
    assert second.data == archive.data
