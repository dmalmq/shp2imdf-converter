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
from backend.src.tile_layers import TilePlan
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

    worker.repair_sources(project, _map(layers), tmp_path, {layer.uri for layer in layers})

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
        worker.repair_sources(_Project(layers, tmp_path), _map(layers), tmp_path, {layer.uri for layer in layers})

    assert str(failed.value) == "2 layers have no data in the upload and would be left out of the tiles: Floors\\1F, Floors\\2F"
    warnings = [line["text"] for line in _lines(capsys.readouterr().out) if line["event"] == "warning"]
    assert warnings == ["Floors\\1F: 0 folders named 'nowhere.gdb' in the upload", "Floors\\2F: 2 folders named 'shp' in the upload"]


def test_a_broken_layer_left_out_on_the_page_does_not_fail_the_build(worker, tmp_path, capsys) -> None:
    layers = [
        _Layer("2F\\背景_グレー_2F", r"D:\gone\JRTokyoSta_3857.gdb", broken=True),
        _Layer("2F\\Space", None, broken=False),
    ]
    project = _Project(layers, tmp_path)

    worker.repair_sources(project, _map(layers), tmp_path, {layers[1].uri})

    warnings = [line["text"] for line in _lines(capsys.readouterr().out) if line["event"] == "warning"]
    assert warnings[-1] == "Broken but not chosen for tiling, so left out: 2F\\背景_グレー_2F"


def test_only_chosen_broken_layers_are_named_in_the_failure(worker, tmp_path) -> None:
    layers = [
        _Layer("1F\\chosen", r"D:\gone\a.gdb", broken=True),
        _Layer("1F\\left_out", r"D:\gone\a.gdb", broken=True),
    ]

    with pytest.raises(worker.BuildFailed) as failed:
        worker.repair_sources(_Project(layers, tmp_path), _map(layers), tmp_path, {layers[0].uri})

    assert str(failed.value) == "1 layers have no data in the upload and would be left out of the tiles: 1F\\chosen"


class _CimLayer:
    """A layer whose CIM names its workspace the way Pro's does, its join's other table included."""

    def __init__(self, name: str, *databases: str) -> None:
        self.longName = name
        self.isGroupLayer = False
        tables = [SimpleNamespace(workspaceConnectionString=f"AUTHENTICATION_MODE=OSA;DATABASE={db}", dataset=name) for db in databases]
        connection = tables[0] if len(tables) == 1 else SimpleNamespace(sourceTable=tables[0], destinationTable=tables[1])
        self.cim = SimpleNamespace(uRI=f"CIMPATH=map/{name}.json", featureTable=SimpleNamespace(dataConnection=connection))
        self.saved = None

    def getDefinition(self, version: str) -> SimpleNamespace:  # noqa: N802
        return self.cim

    def setDefinition(self, cim) -> None:  # noqa: N802
        self.saved = cim

    def databases(self) -> list[str]:
        cim = self.saved or self.cim
        connection = cim.featureTable.dataConnection
        tables = [connection] if hasattr(connection, "workspaceConnectionString") else [connection.sourceTable, connection.destinationTable]
        return [table.workspaceConnectionString for table in tables]


def test_a_geodatabase_on_the_network_is_copied_once_and_its_layers_pointed_at_the_copy(worker, tmp_path, capsys) -> None:
    share = tmp_path / "share"
    station = share / "JRShinjukuSta.gdb"
    points = share / "points.gdb"
    for gdb in (station, points):
        gdb.mkdir(parents=True)
        (gdb / "a00000001.gdbtable").write_bytes(gdb.name.encode())
    (station / "a00000001.sr.lock").write_bytes(b"")
    local = tmp_path / "local.gdb"
    local.mkdir()
    layers = [
        _CimLayer("1F", str(station)),
        _CimLayer("2F", str(station).upper()),
        _CimLayer("joined", str(local), str(points)),
        _CimLayer("base", str(local)),
        _CimLayer("gone", str(share / "gone.gdb")),
    ]
    data = tmp_path / "out" / "data"

    changed = worker.localise(_map(layers), data, remote=lambda path: path.casefold().startswith(str(share).casefold()))

    assert changed
    assert sorted(p.relative_to(data).as_posix() for p in data.rglob("*")) == [
        "JRShinjukuSta.gdb", "JRShinjukuSta.gdb/a00000001.gdbtable", "points.gdb", "points.gdb/a00000001.gdbtable"
    ]
    osa = "AUTHENTICATION_MODE=OSA;DATABASE="
    assert [layer.databases() for layer in layers] == [
        [osa + str(data / "JRShinjukuSta.gdb")],
        [osa + str(data / "JRShinjukuSta.gdb")],
        [osa + str(local), osa + str(data / "points.gdb")],
        [osa + str(local)],
        [osa + str(share / "gone.gdb")],
    ]
    assert [layer.saved is not None for layer in layers] == [True, True, True, False, False]
    assert _lines(capsys.readouterr().out)[-1] == {"event": "message", "text": "Layers pointed at a local copy: 3"}


def test_a_map_with_nothing_on_the_network_copies_nothing(worker, tmp_path) -> None:
    local = tmp_path / "local.gdb"
    local.mkdir()
    layers = [_CimLayer("base", str(local)), _Layer("Floors", None, broken=False, group=True)]

    assert not worker.localise(_map(layers), tmp_path / "data", remote=lambda path: False)
    assert not (tmp_path / "data").exists()


@pytest.mark.parametrize(
    "path, remote", [(r"\\server\share\a.gdb", True), (r"C:\data\a.gdb", False), (r".\data\a.gdb", False)]
)
def test_unc_paths_are_remote_and_local_or_relative_ones_are_not(worker, path, remote) -> None:
    assert worker.is_remote(path) is remote


class _Map:
    def __init__(self, name: str, uri: str | None, layers: list[_Layer] | None = None) -> None:
        self.name = name
        self.uri = uri
        self.layers = layers or []
        self.metadata = SimpleNamespace(title="t", tags="t", summary="s", description="d", credits="c", accessConstraints="a")

    def listLayers(self) -> list[_Layer]:  # noqa: N802
        return self.layers

    def getDefinition(self, version: str) -> SimpleNamespace:  # noqa: N802
        if self.uri is None:
            raise RuntimeError("no CIM here")
        return SimpleNamespace(uRI=self.uri)


def _maps(*maps: _Map) -> SimpleNamespace:
    return SimpleNamespace(listMaps=lambda: list(maps))


def test_the_map_is_found_by_its_uri_whatever_the_others_are_called(worker) -> None:
    station = _Map("マップ", "CIMPATH=map1/map.json")
    project = _maps(_Map("マップ", "CIMPATH=map/map.json"), station)

    assert worker.chosen_map(project, "CIMPATH=Map1/Map.json", "マップ") is station


def test_without_a_uri_the_map_is_found_by_its_name_with_a_warning(worker, capsys) -> None:
    station = _Map("マップ レイヤー", None)

    assert worker.chosen_map(_maps(_Map("マップ", None), station), "CIMPATH=map1/map.json", "マップ レイヤー") is station
    assert _lines(capsys.readouterr().out) == [
        {"event": "warning", "text": "No map has the uRI CIMPATH=map1/map.json; tiling the one called 'マップ レイヤー'"}
    ]


@pytest.mark.parametrize("names", [("マップ", "2F"), ("1F", "1F")])
def test_a_map_neither_uri_nor_name_tells_apart_fails_naming_the_maps(worker, names) -> None:
    project = _maps(*(_Map(name, None) for name in names))

    with pytest.raises(worker.BuildFailed, match=r"'1F' \(CIMPATH=map1/map.json\), is not one arcpy can tell apart; the project has 2: '"):
        worker.chosen_map(project, "CIMPATH=map1/map.json", "1F")


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
        seen["map"] = in_map
        seen["tiled"] = [layer.longName for layer in in_map.listLayers() if layer.visible]

    def extract(in_package, output_folder, **_):
        vtiles = _vtiles(Path(output_folder), maxzoom=16, bom=False)
        seen["vtiles"] = vtiles

    return SimpleNamespace(
        CreateFileGDB=lambda *_: None, CreateVectorTileIndex=lambda **_: None, CreateVectorTilePackage=package, ExtractPackage=extract
    )


def test_a_build_tiles_the_chosen_map_and_layers_without_saving_the_choice(worker, tmp_path) -> None:
    layers, plan = _station(tmp_path)
    project = _Project(layers, tmp_path)
    template = _Map("マップ", "CIMPATH=map/map.json", [_Layer("Template", None, broken=False)])
    station = _Map("マップ レイヤー", "CIMPATH=map1/map.json", layers)
    project.listMaps = lambda: [template, station]
    seen: dict = {}
    worker.arcpy.mp.ArcGISProject = lambda path: project
    worker.arcpy.management = _tools(seen)

    told = {"map_uri": "CIMPATH=map1/map.json", "map_name": "マップ レイヤー", "layers": plan}
    vtiles, problems = worker.build(tmp_path / "Sta.aprx", tmp_path, tmp_path / "out", told)

    assert seen["map"] is station
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

    plan = TilePlan(map_uri="CIMPATH=map/map.json", map_name="マップ", layers=())
    job_id = jobs.submit(Archive(filename="p.zip", data=make_zip([("p.aprx", b"x")])), "p.aprx", Path(sys.executable), plan)

    deadline = time.monotonic() + 30
    while not isinstance(status := jobs.status(job_id), Failed):
        assert time.monotonic() < deadline, status
        time.sleep(0.02)
    assert status.reason == "マップ レイヤー を開けません"
    log = (jobs.root / job_id / "build_log.txt").read_text(encoding="utf-8")
    assert "stderr: マップ レイヤー を開けません\n" in log
