"""Which layers of a project's map a vector tile build tiles: the map's layer tree, read without arcpy, and the choice.

An ``.aprx`` is a zip of CIM JSON. ``GISProject.json`` lists the project's
maps as items whose ``catalogPath`` is ``CIMPATH=<member>``; a map member
lists its layers as ``uRI``s, top of the drawing order first, and a group's
member lists its own the same way. A ``uRI`` is what arcpy's
``layer.getDefinition("V3").uRI`` returns, so it is how the worker finds a
layer again.

The default choice is what the project would draw as saved (a layer and
every group above it switched on), less every layer whose own name, or a
group's above it, matches a pattern in ``vector_tile_exclusions.json``.
Nothing about a choice is kept: every build starts from the uploaded project
and the pattern file.
"""

from __future__ import annotations

from collections.abc import Collection, Iterator
from dataclasses import dataclass
from fnmatch import fnmatchcase
from io import BytesIO
import json
from pathlib import Path
from typing import Any, Literal
import zipfile
import zlib

_CIMPATH = "CIMPATH="


@dataclass(frozen=True, slots=True)
class TileExclusions:
    patterns: tuple[str, ...]

    def match(self, name: str) -> str | None:
        """The first pattern ``name`` matches, ignoring case; None when it matches none."""
        folded = name.casefold()
        return next((pattern for pattern in self.patterns if fnmatchcase(folded, pattern.casefold())), None)


NO_EXCLUSIONS = TileExclusions(patterns=())


def load_tile_exclusions(path: Path) -> TileExclusions:
    """Parse and validate the pattern file at startup, so a broken one stops the server rather than a build."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or set(raw) - {"source", "exclude"} or "exclude" not in raw:
        raise ValueError(f"{path.name} must be an object with an 'exclude' list (and optionally 'source')")
    patterns = raw["exclude"]
    if not isinstance(patterns, list):
        raise ValueError(f"{path.name}: 'exclude' must be a list of patterns")
    seen: dict[str, str] = {}
    for index, pattern in enumerate(patterns):
        if not isinstance(pattern, str) or not pattern or pattern != pattern.strip():
            raise ValueError(f"{path.name}: exclude[{index}] must be non-blank text without surrounding spaces")
        if pattern.strip("*?") == "":
            raise ValueError(f"{path.name}: exclude[{index}] {pattern!r} would exclude every layer")
        if (key := pattern.casefold()) in seen:
            raise ValueError(f"{path.name}: {pattern!r} repeats {seen[key]!r}; patterns ignore case")
        seen[key] = pattern
    return TileExclusions(patterns=tuple(patterns))


@dataclass(frozen=True, slots=True)
class LayerNode:
    uri: str
    name: str
    group: bool
    """A group layer: its checkbox stands for the layers in it."""
    visible: bool
    """Its own visibility as the project was saved."""
    excluded_by: str | None
    """The pattern its own name matched, if any."""
    tiled_by_default: bool
    """A layer: drawn as saved and matched by no pattern, its own or a group's above it. A group: any layer in it is."""
    children: tuple[LayerNode, ...]


@dataclass(frozen=True, slots=True)
class MapLayers:
    map: str
    layers: tuple[LayerNode, ...]
    """Top of the drawing order first, as Pro's Contents pane lists them."""
    state: Literal["map"] = "map"


@dataclass(frozen=True, slots=True)
class NotOneMap:
    """A build tiles the project's one map, so it refuses a project with none or several."""

    maps: tuple[str, ...]
    state: Literal["not_one_map"] = "not_one_map"


@dataclass(frozen=True, slots=True)
class LayersUnreadable:
    detail: str
    state: Literal["unreadable"] = "unreadable"


ProjectLayers = MapLayers | NotOneMap | LayersUnreadable


def read_project_layers(project: bytes, exclusions: TileExclusions, *, max_bytes: int) -> ProjectLayers:
    """The layer tree of the project's one map. Reads only ``GISProject.json`` and the members the map reaches."""
    try:
        with zipfile.ZipFile(BytesIO(project)) as archive:
            if sum(info.file_size for info in archive.infolist()) > max_bytes:
                return LayersUnreadable(detail="The project expands past the upload limit.")
            return _Reader(archive, exclusions).project()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error, RuntimeError, NotImplementedError, EOFError) as exc:
        return LayersUnreadable(detail=f"Not a readable project: {exc}")
    except _Unreadable as exc:
        return LayersUnreadable(detail=str(exc))


class _Unreadable(Exception):
    pass


class _Reader:
    def __init__(self, archive: zipfile.ZipFile, exclusions: TileExclusions) -> None:
        self.archive = archive
        self.exclusions = exclusions
        self.members = {name.casefold(): name for name in archive.namelist()}
        self.opened: set[str] = set()

    def document(self, member: str) -> dict[str, Any]:
        name = self.members.get(member.casefold())
        if name is None:
            raise _Unreadable(f"The project has no member {member}")
        try:
            doc = json.loads(self.archive.read(name).decode("utf-8-sig"))
        except (ValueError, RecursionError) as exc:
            raise _Unreadable(f"{member} is not readable JSON: {exc}") from exc
        if not isinstance(doc, dict):
            raise _Unreadable(f"{member} is not a CIM object")
        return doc

    def project(self) -> ProjectLayers:
        items = self.document("GISProject.json").get("projectItems")
        maps = [item for item in items or [] if isinstance(item, dict) and item.get("itemType") == "Map"]
        if len(maps) != 1:
            return NotOneMap(maps=tuple(str(item.get("name", "")) for item in maps))
        the_map = self.document(_member(maps[0].get("catalogPath")))
        return MapLayers(map=str(the_map.get("name", "")), layers=self.layers(the_map, inherited=None, drawn=True))

    def layers(self, parent: dict[str, Any], *, inherited: str | None, drawn: bool) -> tuple[LayerNode, ...]:
        uris = parent.get("layers")
        if not isinstance(uris, list):
            raise _Unreadable(f"{parent.get('name')!r} lists its layers in an unknown form")
        return tuple(self.node(uri, inherited=inherited, drawn=drawn) for uri in uris)

    def node(self, uri: Any, *, inherited: str | None, drawn: bool) -> LayerNode:
        member = _member(uri)
        if member.casefold() in self.opened:
            raise _Unreadable(f"{uri} is listed twice in the map")
        self.opened.add(member.casefold())
        doc = self.document(member)
        name = str(doc.get("name", ""))
        # CIM's default for a property left out; Pro writes it on every layer it saves.
        visible = doc.get("visibility", False) is True
        excluded_by = self.exclusions.match(name)
        if isinstance(doc.get("layers"), list):
            children = self.layers(doc, inherited=excluded_by or inherited, drawn=drawn and visible)
            tiled = any(child.tiled_by_default for child in children)
            return LayerNode(uri, name, True, visible, excluded_by, tiled, children)
        tiled = drawn and visible and excluded_by is None and inherited is None
        return LayerNode(uri, name, False, visible, excluded_by, tiled, ())


def _member(uri: Any) -> str:
    if not isinstance(uri, str) or not uri.startswith(_CIMPATH):
        raise _Unreadable(f"{uri!r} is not a CIMPATH reference")
    return uri.removeprefix(_CIMPATH)


def walk(nodes: tuple[LayerNode, ...], path: tuple[str, ...] = ()) -> Iterator[tuple[LayerNode, str]]:
    """Every node, depth first, with its name joined to its groups' as arcpy's ``longName`` does."""
    for node in nodes:
        long_name = "\\".join((*path, node.name))
        yield node, long_name
        yield from walk(node.children, (*path, node.name))


def default_selection(layers: MapLayers) -> frozenset[str]:
    return frozenset(node.uri for node, _ in walk(layers.layers) if not node.group and node.tiled_by_default)


@dataclass(frozen=True, slots=True)
class LayerVisibility:
    """One line of what the worker sets before tiling."""

    uri: str
    name: str
    """arcpy's ``longName``, for the log."""
    group: bool
    visible: bool


class SelectionError(ValueError):
    pass


def visibility_plan(layers: MapLayers, selected: Collection[str]) -> tuple[LayerVisibility, ...]:
    """The visibility of every layer and group so that exactly the ``selected`` layers are drawn.

    A group is switched on when any layer in it is selected and off otherwise,
    whatever the project saved.
    """
    nodes = {node.uri: (node, long_name) for node, long_name in walk(layers.layers)}
    unknown = sorted(uri for uri in selected if uri not in nodes)
    if unknown:
        raise SelectionError(f"These layers are not in the project's map: {', '.join(unknown)}")
    groups = sorted(nodes[uri][1] for uri in selected if nodes[uri][0].group)
    if groups:
        raise SelectionError(f"Choose layers, not groups: {', '.join(groups)}")
    if not selected:
        raise SelectionError("Choose at least one layer to tile.")
    chosen = set(selected)

    def drawn(node: LayerNode) -> bool:
        return any(drawn(child) for child in node.children) if node.group else node.uri in chosen

    return tuple(
        LayerVisibility(uri=node.uri, name=long_name, group=node.group, visible=drawn(node))
        for node, long_name in walk(layers.layers)
    )
