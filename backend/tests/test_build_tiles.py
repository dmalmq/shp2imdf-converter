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
import time
from types import ModuleType, SimpleNamespace

import pytest

from backend.src.recolor import Archive
from backend.src.tile_jobs import Failed, TileJobs
from backend.tests.color_theme_fixtures import make_zip

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
        self.uri = f"CIMPATH=map/{name.replace(chr(92), '_')}.json"
        self.isGroupLayer = group
        self.isBroken = broken
        self.visible = visible
        self.connectionProperties = None if database is None else {"connection_info": {"database": database}}

    def getDefinition(self, version: str) -> SimpleNamespace:  # noqa: N802
        assert version == "V3"
        return SimpleNamespace(uRI=self.uri)


class _Project:
    def __init__(self, layers: list[_Layer], root: Path) -> None:
        self.layers = layers
        self.root = root
        self.updates: list[tuple[str, str]] = []
        self.saves: list[dict[str, bool]] = []
        """The visibility of every layer each time the project was saved."""

    def updateConnectionProperties(self, old: str, new: str) -> None:
        self.updates.append((old, new))
        for layer in self.layers:
            info = (layer.connectionProperties or {}).get("connection_info", {})
            if info.get("database") == old:
                info["database"] = new
                layer.isBroken = not Path(new).is_dir()

    def save(self) -> None:
        self.saves.append({layer.longName: layer.visible for layer in self.layers})


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
    assert len(project.saves) == 1


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


def _station(tmp_path: Path) -> tuple[list[_Layer], list[dict]]:
    """A floor group with a moved data source, a hidden layer to switch on and a background to switch off."""
    (tmp_path / "Sta" / "data.gdb").mkdir(parents=True)
    layers = [
        _Layer("Floors", None, broken=False, group=True),
        _Layer("Floors\\1F", r"D:\old\data.gdb", broken=True),
        _Layer("Floors\\B1", r"D:\old\data.gdb", broken=True, visible=False),
        _Layer("Points", None, broken=False, group=True),
        _Layer("Points\\merge_tap", None, broken=False),
        _Layer("Background", None, broken=False),
    ]
    chosen = ("Floors", "Floors\\1F", "Floors\\B1")
    plan = [
        {"uri": layer.uri, "name": layer.longName, "group": layer.isGroupLayer, "visible": layer.longName in chosen}
        for layer in layers
    ]
    return layers, plan


def test_the_chosen_visibility_is_set_and_logged_with_empty_groups_warned(worker, tmp_path, capsys) -> None:
    layers, plan = _station(tmp_path)

    worker.apply_layers(_map(layers), plan)

    assert {layer.longName: layer.visible for layer in layers} == {line["name"]: line["visible"] for line in plan}
    assert _lines(capsys.readouterr().out) == [
        {"event": "message", "text": "Layers to tile: 2"},
        {"event": "message", "text": "Switched on for tiling: Floors\\B1"},
        {"event": "message", "text": "Switched off for tiling: Points, Points\\merge_tap, Background"},
        {"event": "warning", "text": "These groups have no layer chosen and are switched off: Points"},
    ]


def test_a_chosen_layer_arcpy_does_not_find_fails_the_build_by_name(worker, tmp_path) -> None:
    layers, plan = _station(tmp_path)
    plan += [{"uri": "CIMPATH=map/gone.json", "name": "Floors\\2F", "group": False, "visible": True}]

    with pytest.raises(worker.BuildFailed, match=r"^1 layers chosen on the page are not in the map arcpy opened: Floors\\2F$"):
        worker.apply_layers(_map(layers), plan)

    assert [layer.visible for layer in layers] == [True, True, False, True, True, True]


def _tools(seen: dict) -> SimpleNamespace:
    """arcpy.management as far as a build goes; the package records which layers it would have drawn."""

    def package(in_map, **_):
        seen["tiled"] = [layer.longName for layer in in_map.listLayers() if layer.visible]

    def extract(in_package, output_folder, **_):
        vtiles = _vtiles(Path(output_folder), maxzoom=16, bom=False)
        seen["vtiles"] = vtiles

    return SimpleNamespace(
        CreateFileGDB=lambda *_: None, CreateVectorTileIndex=lambda **_: None, CreateVectorTilePackage=package, ExtractPackage=extract
    )


def test_a_build_tiles_the_choice_without_saving_it_into_the_project(worker, tmp_path) -> None:
    layers, plan = _station(tmp_path)
    project = _Project(layers, tmp_path)
    metadata = SimpleNamespace(title="t", tags="t", summary="s", description="d", credits="c", accessConstraints="a")
    the_map = SimpleNamespace(name="Map", listLayers=lambda: layers, metadata=metadata)
    project.listMaps = lambda: [the_map]
    seen: dict = {}
    worker.arcpy.mp.ArcGISProject = lambda path: project
    worker.arcpy.management = _tools(seen)

    vtiles, problems = worker.build(tmp_path / "Sta.aprx", tmp_path, tmp_path / "out", plan)

    assert seen["tiled"] == ["Floors", "Floors\\1F", "Floors\\B1"]
    as_uploaded = {layer.longName: layer.longName != "Floors\\B1" for layer in layers}
    assert project.saves == [as_uploaded]
    assert (vtiles, problems) == (seen["vtiles"], [])


def test_an_arcpy_error_exits_1_with_its_error_line(worker, tmp_path, capsys) -> None:
    def refuse(path: str):
        raise RuntimeError("ERROR 000732: Input Map: Dataset does not exist\nFailed to execute (CreateVectorTileIndex).")

    worker.arcpy.mp.ArcGISProject = refuse
    (tmp_path / "layers.json").write_text('{"layers": []}', encoding="utf-8")

    with pytest.raises(SystemExit) as exited:
        worker.main([str(tmp_path / "p.aprx"), str(tmp_path), str(tmp_path / "out"), str(tmp_path / "layers.json")])

    captured = capsys.readouterr()
    assert exited.value.code == 1
    assert _lines(captured.out)[-1] == {"event": "failed", "reason": "ERROR 000732: Input Map: Dataset does not exist"}
    assert captured.err.strip().splitlines()[-1] == "ERROR 000732: Input Map: Dataset does not exist"


_JAPANESE_CONSOLE = """
import io, runpy, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="cp932", line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="cp932", line_buffering=True)
sys.path.insert(0, {stub!r})
sys.argv = [{worker!r}, *sys.argv[1:]]
runpy.run_path({worker!r}, run_name="__main__")
"""

_REFUSING_ARCPY = """
class mp:
    @staticmethod
    def ArcGISProject(path):
        raise RuntimeError("マップ レイヤー を開けません")
"""


def test_a_japanese_failure_reaches_the_build_log_intact_under_a_cp932_console(tmp_path) -> None:
    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "arcpy.py").write_text(_REFUSING_ARCPY, encoding="utf-8")
    launcher = tmp_path / "launcher.py"
    launcher.write_text(_JAPANESE_CONSOLE.format(stub=str(stub), worker=str(WORKER)), encoding="utf-8")
    jobs = TileJobs(tmp_path / "j", ttl_seconds=3600, script=launcher)

    job_id = jobs.submit(Archive(filename="p.zip", data=make_zip([("p.aprx", b"x")])), "p.aprx", Path(sys.executable), ())

    deadline = time.monotonic() + 30
    while not isinstance(status := jobs.status(job_id), Failed):
        assert time.monotonic() < deadline, status
        time.sleep(0.02)
    assert status.reason == "マップ レイヤー を開けません"
    log = (jobs.root / job_id / "build_log.txt").read_text(encoding="utf-8")
    assert "stderr: マップ レイヤー を開けません\n" in log
