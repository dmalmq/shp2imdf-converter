"""The vector tile worker's own logic, with a stub ``arcpy``: the real one needs an ArcGIS Pro licence.

What arcpy's tools produce is not tested here and has not been run on this
machine; these pin the protocol the server parses, the root.json edit, the
checks, and the repair of data sources broken by the upload.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

pytestmark = [pytest.mark.colortheme, pytest.mark.vectortiles]

WORKER = Path(__file__).resolve().parents[1] / "src" / "build_tiles.py"


@pytest.fixture()
def worker(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    stub = SimpleNamespace(GetMessages=lambda: "", env=SimpleNamespace(), mp=SimpleNamespace(), management=SimpleNamespace())
    monkeypatch.setitem(sys.modules, "arcpy", stub)
    spec = importlib.util.spec_from_file_location("build_tiles_under_test", WORKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _lines(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines()]


def _vtiles(root: Path, levels=range(15, 22), maxzoom=21, bom=True) -> Path:
    vtiles = root / "s.vtiles"
    styles = vtiles / "resources" / "styles"
    styles.mkdir(parents=True)
    style = {"version": 8, "name": "東京駅", "sources": {"esri": {"type": "vector", "maxzoom": maxzoom}, "b": {"maxzoom": maxzoom}}}
    (styles / "root.json").write_bytes((b"\xef\xbb\xbf" if bom else b"") + json.dumps(style, ensure_ascii=False).encode("utf-8"))
    for z in levels:
        tile = vtiles / "tile" / str(z) / "0"
        tile.mkdir(parents=True)
        (tile / "0.pbf").write_bytes(b"x")
    return vtiles


def test_a_step_is_one_ascii_json_line(worker, capsys) -> None:
    worker.step(3, "パッケージ")

    out = capsys.readouterr().out
    assert out.isascii()
    assert _lines(out) == [{"event": "step", "step": 3, "of": 5, "label": "パッケージ"}]


def test_maxzoom_is_set_on_every_source_and_written_without_a_bom(worker, tmp_path) -> None:
    vtiles = _vtiles(tmp_path)
    root_json = vtiles / "resources" / "styles" / "root.json"

    worker.set_maxzoom(root_json, 16)

    raw = root_json.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    style = json.loads(raw.decode("utf-8"))
    assert [src["maxzoom"] for src in style["sources"].values()] == [16, 16]
    assert style["name"] == "東京駅"
    assert worker.check(vtiles, 16) == []


def test_checks_name_a_bom_a_wrong_maxzoom_and_missing_levels(worker, tmp_path) -> None:
    vtiles = _vtiles(tmp_path, levels=range(15, 21), maxzoom=21)

    problems = worker.check(vtiles, 16)

    assert problems == [
        "root.json starts with a BOM",
        "source 'esri' maxzoom is 21, expected 16",
        "source 'b' maxzoom is 21, expected 16",
        "missing zoom levels [21]",
    ]


def test_a_boolean_maxzoom_is_not_sixteen(worker, tmp_path) -> None:
    vtiles = _vtiles(tmp_path, maxzoom=True, bom=False)

    assert worker.check(vtiles, 1) == ["source 'esri' maxzoom is True, expected 1", "source 'b' maxzoom is True, expected 1"]


class _Layer:
    def __init__(self, name: str, database: str | None, broken: bool, group: bool = False, visible: bool = True) -> None:
        self.name = self.longName = name
        self.isGroupLayer = group
        self.isBroken = broken
        self.visible = visible
        self.connectionProperties = None if database is None else {"connection_info": {"database": database}}


class _Project:
    def __init__(self, layers: list[_Layer], root: Path) -> None:
        self.layers = layers
        self.root = root
        self.updates: list[tuple[str, str]] = []
        self.saved = False

    def updateConnectionProperties(self, old: str, new: str) -> None:
        self.updates.append((old, new))
        for layer in self.layers:
            info = (layer.connectionProperties or {}).get("connection_info", {})
            if info.get("database") == old:
                info["database"] = new
                layer.isBroken = not Path(new).is_dir()

    def save(self) -> None:
        self.saved = True


def _map(layers: list[_Layer]):
    return SimpleNamespace(name="Map", listLayers=lambda: layers)


def test_a_moved_geodatabase_is_found_by_name_under_the_upload(worker, tmp_path) -> None:
    gdb = tmp_path / "Sta" / "Data.GDB"
    gdb.mkdir(parents=True)
    layers = [
        _Layer("Floors", None, broken=False, group=True),
        _Layer("Floors\\1F", r"D:\area\ArcProPrj\data.gdb", broken=True),
        _Layer("Floors\\2F", r"D:\area\ArcProPrj\data.gdb", broken=True),
        _Layer("Base", str(gdb), broken=False),
    ]
    project = _Project(layers, tmp_path)

    worker.repair_sources(project, _map(layers), tmp_path)

    assert project.updates == [(r"D:\area\ArcProPrj\data.gdb", str(gdb))]
    assert not any(layer.isBroken for layer in layers)
    assert project.saved


def test_a_layer_left_broken_fails_the_build_by_name(worker, tmp_path, capsys) -> None:
    for folder in ("a/shp", "b/shp"):
        (tmp_path / folder).mkdir(parents=True)
    layers = [
        _Layer("Floors\\1F", r"D:\gone\nowhere.gdb", broken=True),
        _Layer("Floors\\2F", r"D:\old\shp", broken=True),
        _Layer("Base", None, broken=False),
    ]

    with pytest.raises(worker.BuildFailed) as failed:
        worker.repair_sources(_Project(layers, tmp_path), _map(layers), tmp_path)

    assert str(failed.value) == "2 layers have no data in the upload and would be left out of the tiles: Floors\\1F, Floors\\2F"
    warnings = [line["text"] for line in _lines(capsys.readouterr().out) if line["event"] == "warning"]
    assert warnings == ["Floors\\1F: 0 folders named 'nowhere.gdb' in the upload", "Floors\\2F: 2 folders named 'shp' in the upload"]


def test_a_project_needs_exactly_one_map(worker) -> None:
    project = SimpleNamespace(listMaps=lambda: [SimpleNamespace(name="1F"), SimpleNamespace(name="B1")])

    with pytest.raises(worker.BuildFailed, match="exactly one map; it has 2: '1F', 'B1'"):
        worker.only_map(project)


def test_hidden_top_level_groups_are_warned_about(worker, capsys) -> None:
    layers = [
        _Layer("Background", None, broken=False, group=True, visible=False),
        _Layer("Floors", None, broken=False, group=True),
        _Layer("Floors\\Hidden", None, broken=False, group=True, visible=False),
    ]

    worker.warn_hidden_groups(_map(layers))

    assert _lines(capsys.readouterr().out) == [
        {"event": "warning", "text": "These top-level groups are switched off and will NOT be tiled: Background"}
    ]


def test_an_arcpy_error_exits_1_with_its_error_line(worker, tmp_path, capsys) -> None:
    def refuse(path: str):
        raise RuntimeError("ERROR 000732: Input Map: Dataset does not exist\nFailed to execute (CreateVectorTileIndex).")

    worker.arcpy.mp.ArcGISProject = refuse

    with pytest.raises(SystemExit) as exited:
        worker.main([str(tmp_path / "p.aprx"), str(tmp_path), str(tmp_path / "out")])

    captured = capsys.readouterr()
    assert exited.value.code == 1
    assert _lines(captured.out)[-1] == {"event": "failed", "reason": "ERROR 000732: Input Map: Dataset does not exist"}
    assert captured.err.strip().splitlines()[-1] == "ERROR 000732: Input Map: Dataset does not exist"
