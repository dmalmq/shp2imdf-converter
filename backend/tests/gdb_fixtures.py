"""File Geodatabases for the colour tool's tests, built and read through ``gdb_fixture_tool.py``.

The tool runs in the same interpreter as ``gdb_worker.py`` (``find_gdal_python``),
so a test needs no ``osgeo`` in the backend's own Python.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from backend.src.gdb import find_gdal_python
from backend.tests.color_theme_fixtures import make_zip

TOOL = Path(__file__).with_name("gdb_fixture_tool.py")


def _tool(python: Path, *args: str, stdin: bytes = b"") -> dict:
    done = subprocess.run([str(python), "-I", str(TOOL), *args], input=stdin, capture_output=True, timeout=120)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace"))
    return json.loads(done.stdout)


def space(name: str, rows: list[tuple[str | None, str | None]], *, width: int = 12, dataset: str | None = "Station") -> dict:
    """A Space class: ``name``, ``category`` and ``color2`` (``width`` characters), indexed on color2."""
    return {
        "name": name,
        "dataset": dataset,
        "fields": [["name", 20], ["category", 10], ["color2", width]],
        "index": ["color2"],
        "rows": [{"name": f"room {index}", "category": category, "color2": color2} for index, (color2, category) in enumerate(rows)],
    }


def build_gdb(path: Path, classes: list[dict], python: Path) -> Path:
    _tool(python, "build", str(path), stdin=json.dumps({"classes": classes}).encode("ascii"))
    return path


def dump_gdb(path: Path, python: Path) -> dict:
    """``{"layers": {name: {"widths", "rows": [{"fid", "fields", "wkb"}]}}, "tables": {name: file stem}}``."""
    return _tool(python, "dump", str(path))


def table_stems(path: Path, python: Path) -> dict[str, str]:
    """Table name to the stem its files share, e.g. ``a00000009``."""
    return _tool(python, "tables", str(path))["tables"]


def filter_fids(path: Path, layer: str, where: str, python: Path) -> list[int]:
    return _tool(python, "filter", str(path), layer, where)["fids"]


def gdb_files(path: Path, prefix: str) -> list[tuple[str, bytes]]:
    """Every file of the geodatabase as upload entries under ``prefix``, in name order."""
    return [(f"{prefix}/{file.name}", file.read_bytes()) for file in sorted(path.iterdir()) if file.is_file()]


def demo_geodatabase() -> bytes:
    """A zipped geodatabase for capture.mjs: a width-254, a width-12 and a no-limit class, one too narrow (8)
    for 階段・エスカレーター, two values the table does not know, a class without color2, and stale lock files."""
    python = find_gdal_python()
    if python is None:
        raise RuntimeError("no Python with GDAL's osgeo; set GDB_GDAL_PYTHON")
    floor_1 = [
        *[("白", "B021")] * 12,
        *[("薄鼠", "B022")] * 9,
        *[("進入制限あり", "B999")] * 6,
        *[("薄空", "B001")] * 5,
        *[("トイレ", "B008")] * 3,
        ("濃鼠", "B010"),
        *[("赤", "B019")] * 2,
    ]
    classes = [
        space("DemoSta_1_Space", floor_1, width=254, dataset="DemoSta"),
        space("DemoSta_B1_Space", [("白", "B021"), ("黄", "B999"), ("黄", "B999")], width=12, dataset="DemoSta"),
        space("DemoSta_0_Space", [("ラチ外白", "B999"), ("道白", "B029")], width=0, dataset="DemoSta"),
        space("DemoSta_2_Space", [("白", "B021"), ("濃空", "B001")], width=8, dataset=None),
        {"name": "DemoSta_1_Facility", "dataset": "DemoSta", "fields": [["name", 20]], "rows": [{"name": "gate"}]},
    ]
    with TemporaryDirectory() as folder:
        gdb = build_gdb(Path(folder) / "DemoSta_3857.gdb", classes, python)
        locks = [(f"DemoSta_3857.gdb/{name}.CL202405004.13112.44100.sr.lock", b"") for name in ("_gdb", "DemoSta_1_Space")]
        return make_zip([*gdb_files(gdb, "DemoSta_3857.gdb"), *locks])


def fingerprint(path: Path) -> dict[str, tuple[str, int]]:
    """File name to (sha256, mtime in ns)."""
    return {
        file.name: (hashlib.sha256(file.read_bytes()).hexdigest(), file.stat().st_mtime_ns)
        for file in sorted(path.iterdir())
        if file.is_file()
    }
