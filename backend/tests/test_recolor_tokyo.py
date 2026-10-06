"""The real Tokyo station from the shared drive: counts, byte fidelity and a second run.

Read-only on Q:. Skipped where the shared drive is not mounted.
"""

from __future__ import annotations

from pathlib import Path

import pyogrio
import pytest

from backend.src.color_theme import load_color_theme
from backend.src.dbf_table import DbfTable
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import read_zip

TOKYO = Path("Q:/BIM/past/受け渡しフォルダ/Daniel/Open Data Project/01_6677/JRTokyoSta_6677.shp")
CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 1024 * 1024 * 1024

# Measured by survey of the shared-drive folder (old value -> rows, area written).
EXPECTED = {
    "白": (711, "階段・エスカレーター"),
    "薄鼠": (612, "進入制限エリア"),
    "薄空": (347, "施設"),
    "濃空": (229, "施設"),
    "トイレ": (113, "施設"),
    "ラチ外白": (70, "改札外通路"),
    "道白": (20, "改札外通路"),
    "濃鼠": (3, "改札外通路"),
    "黄": (24, "在来線改札内"),
    "薄紅": (9, "在来線改札内"),
    "橙": (17, "新幹線改札内"),
    "緑": (4, "新幹線改札内"),
    "濃紅": (5, "新幹線改札内"),
}

pytestmark = [
    pytest.mark.colortheme,
    pytest.mark.skipif(not TOKYO.is_dir(), reason="JRTokyoSta sample is only on the shared drive"),
]


def _color2_spans(table: DbfTable) -> set[int]:
    field = table.field("color2")
    spans: set[int] = set()
    for row in table.live_rows():
        start = table.header_length + row * table.record_length + field.offset
        spans.update(range(start, start + field.width))
    return spans


def test_tokyo_station_is_recoloured_and_nothing_else_moves(tmp_path: Path) -> None:
    theme = load_color_theme(CONFIG)
    blobs = [(f"{TOKYO.name}/{path.name}", path.read_bytes()) for path in sorted(TOKYO.iterdir()) if path.is_file()]

    inspection = inspect(theme, blobs, max_bytes=LIMIT)
    archive = convert(theme, blobs, max_bytes=LIMIT)

    report = inspection.theme
    rows_by_old: dict[str, int] = {}
    for line in report.rules:
        rows_by_old[line.old] = rows_by_old.get(line.old, 0) + line.rows
    assert {old: rows for old, rows in rows_by_old.items() if rows} == {old: rows for old, (rows, _) in EXPECTED.items()}
    assert report.totals.recolor == 2164
    assert (report.totals.unmapped, report.totals.too_wide, report.totals.undecodable) == (0, 0, 0)
    assert report.unmapped == () and report.skipped == ()
    assert len(report.layers) == 10
    assert all(layer.id.endswith("_Space.dbf") and layer.encoding.codec == "utf-8" for layer in report.layers)
    assert inspection.dataset.name == "JRTokyoSta_6677"
    assert inspection.dataset.files == len(blobs) == 501
    assert archive.filename == "JRTokyoSta_6677_new-colors.zip"

    output = read_zip(archive.data)
    assert list(output) == [name for name, _ in blobs]
    changed = sorted(name for name, data in blobs if output[name] != data)
    assert changed == sorted(layer.id for layer in report.layers)
    for name in changed:
        source = dict(blobs)[name]
        table = DbfTable.parse(source)
        diff = {index for index, (a, b) in enumerate(zip(source, output[name])) if a != b}
        assert len(output[name]) == len(source)
        assert diff <= _color2_spans(table), name
        color2 = table.field("color2")
        after = DbfTable.parse(output[name])
        for row in table.live_rows():
            old = table.text(row, color2).decode("utf-8")
            assert after.text(row, color2).decode("utf-8") == EXPECTED[old][1], (name, row, old)

    written = tmp_path / TOKYO.name
    written.mkdir()
    for name, data in output.items():
        (tmp_path / name).write_bytes(data)
    for name in changed:
        stem = Path(name).stem
        before = pyogrio.read_dataframe(TOKYO / f"{stem}.shp")
        after = pyogrio.read_dataframe(written / f"{stem}.shp")
        others = [column for column in before.columns if column not in ("color2", "geometry")]
        assert list(after.columns) == list(before.columns)
        assert after[others].equals(before[others]), stem
        assert after.geometry.to_wkb().equals(before.geometry.to_wkb()), stem

    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT)
    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT).theme
    assert rerun.totals.recolor == 0
    assert rerun.totals.already_new == 2164
    assert read_zip(second.data) == output
    assert second.data == archive.data
