"""The real Tokyo station project, rethemed on a copy: 127 layers rewritten, every other member unchanged.

The project is not in the repository. Set ``TOKYO_APRX`` to an ``.aprx``
saved by Pro 3.6 from the Tokyo station data; the test copies it first.
"""

from __future__ import annotations

from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import zipfile

import pytest

from backend.src.color_theme import load_color_theme
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import read_zip
from backend.tests.esri_cim import AVAILABLE, esri_read

TOKYO = Path(os.getenv("TOKYO_APRX", "")) if os.getenv("TOKYO_APRX") else None
CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 1024 * 1024 * 1024
FILLS = [
    ("改札外通路", "#FFFFFF"),
    ("在来線改札内", "#F2F7FB"),
    ("新幹線改札内", "#E5EFF7"),
    ("施設", "#DDEBEC"),
    ("進入制限エリア", "#F2F2F2"),
    ("階段・エスカレーター", "#FFFFFF"),
]

pytestmark = [
    pytest.mark.colortheme,
    pytest.mark.skipif(TOKYO is None or not TOKYO.is_file(), reason="set TOKYO_APRX to the Tokyo station project"),
]


def _members(payload: bytes) -> list[tuple[str, tuple[int, ...], int, int, bytes]]:
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        assert archive.testzip() is None
        return [
            (info.filename, info.date_time, info.compress_type, info.CRC, archive.read(info)) for info in archive.infolist()
        ]


def test_tokyo_project_has_its_127_color2_layers_rewritten_and_nothing_else(tmp_path: Path) -> None:
    assert TOKYO is not None
    theme = load_color_theme(CONFIG)
    source = shutil.copyfile(TOKYO, tmp_path / "tokyo.aprx").read_bytes()
    upload = [("tokyo.aprx", source)]

    report = inspect(theme, upload, max_bytes=LIMIT).theme
    archive = convert(theme, upload, max_bytes=LIMIT)

    ((line),) = report.symbology
    assert (line.kind, line.unreadable) == ("aprx", False)
    assert len(line.renderers) == 127
    assert {(r.outcome, r.classes_before, r.classes_after, r.kept) for r in line.renderers} == {("rewritten", 14, 6, ())}
    output = read_zip(archive.data)["tokyo.aprx"]
    before, after = _members(source), _members(output)
    assert len(before) == len(after) == 1648
    assert [m[:3] for m in after] == [m[:3] for m in before]
    changed = [new for old, new in zip(before, after) if old != new]
    unchanged = [new for old, new in zip(before, after) if old == new]
    assert (len(changed), len(unchanged)) == (127, 1521)
    for member in changed:
        layer = json.loads(member[4])
        labels = [cls["label"] for group in layer["renderer"]["groups"] for cls in group["classes"]]
        assert labels == [label for label, _ in FILLS], member[0]

    if AVAILABLE:
        path = tmp_path / "tokyo_new.aprx"
        path.write_bytes(output)
        read = esri_read(path)
        assert (len(read["layers"]), read["failed"]) == (127, [])
        assert {tuple((cls["label"], cls["fill"]) for cls in layer["classes"]) for layer in read["layers"]} == {tuple(FILLS)}
        assert {cls["stroke"] for layer in read["layers"] for cls in layer["classes"]} == {"#657678"}

    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT).theme
    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT)
    assert {r.outcome for r in rerun.symbology[0].renderers} == {"already_new"}
    assert second.data == archive.data
