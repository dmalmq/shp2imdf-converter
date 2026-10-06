"""The real Tokyo geodatabase from the shared drive, recoloured on a local copy: counts, what changes, a second run.

Q: is only read, by the copy: colleagues edit these folders, so nothing here
opens the original. Skipped where the drive is not mounted or no Python with
GDAL's ``osgeo`` is found.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
import shutil

import pytest

from backend.src.color_theme import load_color_theme
from backend.src.gdb import find_gdal_python, read_layers
from backend.src.recolor import convert, inspect
from backend.tests.color_theme_fixtures import make_zip, read_zip
from backend.tests.gdb_fixtures import filter_fids, fingerprint, table_stems

TOKYO = Path("Q:/BIM/past/受け渡しフォルダ/Daniel/Cesium/NW,POI_20260625東京/JRTokyoSta_3857.gdb")
CONFIG = Path(__file__).resolve().parents[1] / "config" / "color_theme.json"
LIMIT = 1024 * 1024 * 1024
GDAL_PYTHON = find_gdal_python()

# Measured on this geodatabase (old value -> rows rewritten, both 濃鼠 rules together).
EXPECTED = {
    "薄鼠": 1738,
    "白": 1698,
    "薄空": 962,
    "進入制限あり": 572,
    "ラチ外白": 456,
    "トイレ": 251,
    "濃空": 228,
    "黄": 24,
    "道白": 23,
    "橙": 17,
    "濃鼠": 12,
    "薄紅": 9,
    "濃紅": 5,
    "緑": 4,
}

pytestmark = [
    pytest.mark.colortheme,
    pytest.mark.skipif(not TOKYO.is_dir(), reason="JRTokyoSta_3857.gdb is only on the shared drive"),
    pytest.mark.skipif(GDAL_PYTHON is None, reason="no Python with GDAL's osgeo; set GDB_GDAL_PYTHON"),
]


def test_tokyo_geodatabase_is_recoloured_and_no_other_table_or_index_moves(tmp_path: Path) -> None:
    theme = load_color_theme(CONFIG)
    source = shutil.copytree(TOKYO, tmp_path / "source" / TOKYO.name)
    files = sorted(path for path in source.iterdir() if path.is_file())
    locks = [path for path in files if path.name.lower().endswith(".lock")]
    upload = [("JRTokyoSta_3857.zip", make_zip([(f"{TOKYO.name}/{path.name}", path.read_bytes()) for path in files]))]

    inspection = inspect(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)
    archive = convert(theme, upload, max_bytes=LIMIT, gdal_python=GDAL_PYTHON)

    report = inspection.theme
    rows_by_old: Counter[str] = Counter()
    for line in report.rules:
        rows_by_old[line.old] += line.rows
    assert {old: rows for old, rows in rows_by_old.items() if rows} == EXPECTED
    assert report.totals.recolor == sum(EXPECTED.values())
    assert (report.totals.unmapped, report.totals.too_wide, report.totals.undecodable) == (0, 0, 0)
    assert report.unmapped == () and report.skipped == ()
    assert len(report.layers) == 64
    assert all(layer.encoding.source == "gdb" and layer.width_unit == "characters" for layer in report.layers)
    assert (inspection.dataset.geodatabases, inspection.dataset.lock_files_dropped) == (1, len(locks))
    assert archive.filename == "JRTokyoSta_3857_new-colors.zip"

    output = read_zip(archive.data)
    result = tmp_path / "result" / TOKYO.name
    result.mkdir(parents=True)
    for name, data in output.items():
        if data is not None:
            (result / name.removeprefix(f"{TOKYO.name}/")).write_bytes(data)
    stems = table_stems(source, GDAL_PYTHON)
    edited = {stems[layer.id.removeprefix(f"{TOKYO.name}/")] for layer in report.layers if layer.counts.recolor}
    old, new = fingerprint(source), fingerprint(result)
    assert not any(name.endswith(".lock") for name in new)
    unedited = [name for name in old if not name.endswith(".lock") and name.split(".", 1)[0] not in edited]
    assert [name for name in unedited if new.get(name, ("gone",))[0] != old[name][0]] == []
    indexes = [name for name in old if name.endswith((".spx", ".atx"))]
    assert [name for name in indexes if name not in new] == []
    scanned = next(layer for layer in read_layers(result, TOKYO.name, theme, GDAL_PYTHON) if layer.id == f"{TOKYO.name}/JRTokyoSta_1_Space")
    facilities = sorted(row.index for row in scanned.rows if row.value == "施設")
    assert facilities and filter_fids(result, "JRTokyoSta_1_Space", "color2 = '施設'", GDAL_PYTHON) == facilities

    rerun = inspect(theme, [(archive.filename, archive.data)], max_bytes=LIMIT, gdal_python=GDAL_PYTHON).theme
    second = convert(theme, [(archive.filename, archive.data)], max_bytes=LIMIT, gdal_python=GDAL_PYTHON)
    assert rerun.totals.recolor == 0
    assert rerun.totals.already_new == sum(EXPECTED.values())
    assert second.data == archive.data
