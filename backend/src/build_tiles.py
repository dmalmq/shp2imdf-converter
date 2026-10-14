"""Export an ArcGIS Pro project's map as Stenavi vector tiles, for the colour tool's "Build vector tiles" option.

Steps 3-4 of "Vector tiles from ArcGIS Pro for Stenavi": index (5000 vertices)
-> metadata -> .vtpk (1:9,028 -> 1:141, Indexed) -> extract (Exploded,
ready-to-serve) -> root.json maxzoom 21 -> 16 -> checks. Only visible layers
are tiled, and which those are is the operator's choice on the page.

``tile_jobs.py`` runs it in a Python with a licensed ``arcpy`` as
``python -I build_tiles.py <project.aprx> <upload root> <out dir> <layers.json>``.
It imports nothing from ``backend``. ``<upload root>`` is the folder the project
was unpacked into with the rest of the upload; data sources broken by the move
are looked up there. ``<layers.json>`` is ``{"map_uri", "map_name",
"layers": [{"uri", "name", "group", "visible"}, ...]}``: the map chosen on
the page, and every layer and group of it with the visibility to tile it
with. The map and its layers' uRIs are one choice, so they travel in one
file. The visibility is set in memory after the data sources are repaired
and saved, and never saved itself.

Every stdout line it writes itself is one ASCII JSON object, so the console
code page never decides how a Japanese name crosses the pipe:

- ``{"event": "step", "step": n, "of": 5, "label": ...}`` as each step starts;
- ``{"event": "message", "text": ...}`` and ``{"event": "warning", "text": ...}`` for the build log;
- ``{"event": "result", "vtiles": <path>, "problems": [...]}`` last, exit 0;
- ``{"event": "failed", "reason": ...}`` last, exit 1, with the reason also the last line of stderr.

Anything else on stdout (arcpy's own output) is not JSON and goes to the log as it is.
stdout and stderr are UTF-8 whatever the console code page, which is how the server reads them.
"""

from __future__ import annotations

import json
import os
from pathlib import Path, PureWindowsPath
import sys

if __name__ == "__main__":
    # A pipe gets the console code page (cp932 on a Japanese Windows), and -I ignores PYTHONIOENCODING.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=True), flush=True)


def log(text: str) -> None:
    emit("message", text=text)


def warn(text: str) -> None:
    emit("warning", text=text)


class BuildFailed(Exception):
    """A one-line reason the build cannot go on."""


def fail(reason: str) -> None:
    emit("failed", reason=reason)
    print(reason, file=sys.stderr, flush=True)
    sys.exit(1)


try:
    import arcpy
except Exception as exc:  # arcpy raises RuntimeError when unlicensed, ImportError when absent
    fail(f"arcpy could not be loaded: {exc}")

STEPS = 5
# Web Mercator (ArcGIS Online / Google) scales for the old 256px levels 16 and 22.
# Exact values so the tool snaps to the tiling scheme's levels rather than rounding.
MIN_SCALE = 9027.977411  # 1:9,028, z15 in 512px numbering
MAX_SCALE = 141.062147  # 1:141,   z21 in 512px numbering
EXPECTED_LEVELS = set(range(15, 22))
VERTICES = 5000
MAXZOOM = 16

DEFAULT_METADATA = {
    "tags": "Stenavi, vector tiles, indoor map",
    "summary": "Indoor station map vector tiles for Stenavi",
    "description": "Indoor station map vector tiles for the Stenavi app.",
    "credits": "",
    "accessConstraints": "Internal use only",
}


def step(number: int, label: str) -> None:
    emit("step", step=number, of=STEPS, label=label)


def chosen_map(aprx, uri: str, name: str):
    """The map chosen on the page: the one whose CIM uRI is ``uri``, else the one map called ``name``."""
    maps = aprx.listMaps()
    by_uri = [m for m in maps if (_uri(m) or "").casefold() == uri.casefold()]
    if len(by_uri) == 1:
        return by_uri[0]
    by_name = [m for m in maps if m.name == name]
    if not by_uri and len(by_name) == 1:
        warn(f"No map has the uRI {uri}; tiling the one called {name!r}")
        return by_name[0]
    names = ", ".join(f"{m.name!r} ({_uri(m)})" for m in maps) or "none"
    raise BuildFailed(
        f"The map chosen on the page, {name!r} ({uri}), is not one arcpy can tell apart; the project has {len(maps)}: {names}"
    )


def find_folder(root: Path, name: str) -> list[Path]:
    """Every folder under ``root`` called ``name``, ignoring case as Windows does."""
    wanted = name.casefold()
    found = []
    for parent, folders, _ in os.walk(root):
        for folder in folders:
            if folder.casefold() == wanted:
                found.append(Path(parent) / folder)
    return found


def _workspace(layer) -> str | None:
    """The folder or geodatabase a layer reads from, as the project recorded it."""
    try:
        properties = layer.connectionProperties
    except Exception:
        return None
    info = (properties or {}).get("connection_info") or {}
    return info.get("database")


def _broken(m) -> list:
    return [layer for layer in m.listLayers() if not layer.isGroupLayer and layer.isBroken]


def repair_sources(aprx, m, root: Path) -> None:
    """Point layers whose data moved with the project at the same-named folder under ``root``.

    A layer still broken would silently drop out of the tiles, so any left raises.
    """
    moved: dict[str, str] = {}
    for layer in _broken(m):
        old = _workspace(layer)
        if old is None or old in moved:
            continue
        matches = find_folder(root, PureWindowsPath(old).name)
        if len(matches) == 1:
            moved[old] = str(matches[0])
        else:
            warn(f"{layer.longName}: {len(matches)} folders named {PureWindowsPath(old).name!r} in the upload")
    for old, new in moved.items():
        log(f"Data source {old} -> {new}")
        aprx.updateConnectionProperties(old, new)
    still = _broken(m)
    if still:
        names = ", ".join(layer.longName for layer in still)
        raise BuildFailed(f"{len(still)} layers have no data in the upload and would be left out of the tiles: {names}")
    if moved:
        aprx.save()


def _uri(layer) -> str | None:
    try:
        return layer.getDefinition("V3").uRI
    except Exception:
        return None


def apply_layers(m, plan: list[dict]) -> None:
    """Switch each layer and group on or off as ``plan`` says. Only in memory: nothing saves the project after this."""
    by_uri = {uri: layer for layer in m.listLayers() if (uri := _uri(layer)) is not None}
    missing = [line["name"] for line in plan if line["uri"] not in by_uri]
    if missing:
        raise BuildFailed(f"{len(missing)} layers chosen on the page are not in the map arcpy opened: {', '.join(missing)}")
    switched: dict[bool, list[str]] = {True: [], False: []}
    for line in plan:
        layer = by_uri[line["uri"]]
        if layer.visible != line["visible"]:
            switched[line["visible"]].append(line["name"])
        layer.visible = line["visible"]
    log(f"Layers to tile: {sum(1 for line in plan if line['visible'] and not line['group'])}")
    if switched[True]:
        log("Switched on for tiling: " + ", ".join(switched[True]))
    if switched[False]:
        log("Switched off for tiling: " + ", ".join(switched[False]))
    empty = [line["name"] for line in plan if line["group"] and not line["visible"]]
    if empty:
        warn("These groups have no layer chosen and are switched off: " + ", ".join(empty))


def ensure_metadata(m, title: str):
    """The package tool refuses maps with empty metadata; fill only the blank fields."""
    md = m.metadata
    if not md.title:
        md.title = title
    for field, value in DEFAULT_METADATA.items():
        if not getattr(md, field):
            setattr(md, field, value or title)
    m.metadata = md
    return md


def set_maxzoom(root_json: Path, maxzoom: int) -> None:
    """Set every source's maxzoom in resources/styles/root.json. Writes UTF-8 without BOM."""
    style = json.loads(root_json.read_text(encoding="utf-8-sig"))
    sources = style.get("sources", {})
    if not sources:
        raise BuildFailed(f"No sources in {root_json}")
    for name, src in sources.items():
        log(f"  source {name!r}: maxzoom {src.get('maxzoom')} -> {maxzoom}")
        src["maxzoom"] = maxzoom
    root_json.write_text(json.dumps(style, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def check(vtiles: Path, maxzoom: int) -> list[str]:
    """What is wrong with the extracted tiles; empty when they are fit for Stenavi."""
    problems = []
    root_json = vtiles / "resources" / "styles" / "root.json"
    raw = root_json.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        problems.append("root.json starts with a BOM")
    for name, src in json.loads(raw.decode("utf-8-sig")).get("sources", {}).items():
        if src.get("maxzoom") != maxzoom or isinstance(src.get("maxzoom"), bool):
            problems.append(f"source {name!r} maxzoom is {src.get('maxzoom')!r}, expected {maxzoom}")

    tile_dir = vtiles / "tile"
    levels = {int(p.name) for p in tile_dir.iterdir() if p.is_dir() and p.name.isdigit()} if tile_dir.is_dir() else set()
    if not levels:
        problems.append(f"no zoom folders in {tile_dir}")
    else:
        counts = {z: sum(1 for _ in (tile_dir / str(z)).rglob("*.pbf")) for z in sorted(levels)}
        log("  tiles per level: " + ", ".join(f"z{z}={n}" for z, n in counts.items()))
        missing = EXPECTED_LEVELS - levels
        if missing:
            problems.append(f"missing zoom levels {sorted(missing)}")
    return problems


def _tool_messages() -> None:
    text = arcpy.GetMessages()
    if text:
        log(text)


def build(aprx_path: Path, root: Path, out_dir: Path, plan: dict) -> tuple[Path, list[str]]:
    aprx = arcpy.mp.ArcGISProject(str(aprx_path))
    m = chosen_map(aprx, plan["map_uri"], plan["map_name"])
    name = aprx_path.stem
    vtpk = out_dir / f"{name}.vtpk"
    extract_dir = out_dir / "tiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    arcpy.env.overwriteOutput = True

    log(f"Map: {m.name} -> {out_dir}")
    repair_sources(aprx, m, root)
    apply_layers(m, plan["layers"])

    # The project's default geodatabase may be a path on the machine it was saved on.
    index_gdb = out_dir / "index.gdb"
    arcpy.management.CreateFileGDB(str(out_dir), index_gdb.stem)
    index_fc = str(index_gdb / f"index_google_{VERTICES}")
    step(1, f"Create Vector Tile Index ({VERTICES} vertices)")
    arcpy.management.CreateVectorTileIndex(
        in_map=m, out_featureclass=index_fc, service_type="ONLINE", tiling_scheme=None, vertex_count=VERTICES
    )
    _tool_messages()

    step(2, "Map metadata")
    md = ensure_metadata(m, name)

    step(3, "Create Vector Tile Package")
    arcpy.management.CreateVectorTilePackage(
        in_map=m,
        output_file=str(vtpk),
        service_type="ONLINE",
        tiling_scheme=None,
        tile_structure="INDEXED",
        min_cached_scale=MIN_SCALE,
        max_cached_scale=MAX_SCALE,
        index_polygons=index_fc,
        summary=md.summary,
        tags=md.tags,
    )
    _tool_messages()

    step(4, "Extract Package (Exploded, ready-to-serve)")
    arcpy.management.ExtractPackage(
        in_package=str(vtpk),
        output_folder=str(extract_dir),
        storage_format_type="EXPLODED",
        create_ready_to_serve_format="READY_TO_SERVE_CACHE_DATASET",
    )
    _tool_messages()

    vtiles_dirs = [p for p in extract_dir.rglob("*.vtiles") if p.is_dir()]
    if len(vtiles_dirs) != 1:
        raise BuildFailed(f"Expected one .vtiles folder under {extract_dir}, found {len(vtiles_dirs)}")
    vtiles = vtiles_dirs[0]

    step(5, f"root.json maxzoom -> {MAXZOOM}, checks")
    set_maxzoom(vtiles / "resources" / "styles" / "root.json", MAXZOOM)
    problems = check(vtiles, MAXZOOM)
    for problem in problems:
        warn("PROBLEM: " + problem)
    return vtiles, problems


def one_line(exc: BaseException) -> str:
    """arcpy's ExecuteError spans lines; its ``ERROR 000nnn`` line says the most."""
    lines = [line.strip() for line in str(exc).splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR")]
    return (errors or lines or [type(exc).__name__])[0]


def main(argv: list[str]) -> None:
    if len(argv) != 4:
        fail("usage: build_tiles.py <project.aprx> <upload root> <out dir> <layers.json>")
    aprx_path, root, out_dir, layers = (Path(arg) for arg in argv)
    try:
        plan = json.loads(layers.read_text(encoding="utf-8"))
        vtiles, problems = build(aprx_path, root, out_dir, plan)
    except BuildFailed as exc:
        fail(str(exc))
    except Exception as exc:
        log(str(exc))
        fail(one_line(exc))
    emit("result", vtiles=str(vtiles), problems=problems)


if __name__ == "__main__":
    main(sys.argv[1:])
