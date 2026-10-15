"""Which map of a project and which of its layers a vector tile build tiles: the layer trees, read without arcpy, and the choice.

An ``.aprx`` is a zip of CIM JSON. ``GISProject.json`` lists the project's
maps as items whose ``catalogPath`` is ``CIMPATH=<member>``; a map member
lists its layers as ``uRI``s, top of the drawing order first, and a group's
member lists its own the same way. A ``uRI`` is what arcpy's
``getDefinition("V3").uRI`` returns for a map or a layer, so it is how the
worker finds them again.

A project often has more than one map: importing an ``.mxd`` adds a map
beside the empty one the project template made. The default is the map with
the most layers, the first in project order on a tie; a map without a layer
cannot be chosen.

The default choice is every layer, whatever visibility the project saved,
less every layer whose own name, or a group's above it, matches a pattern in
``vector_tile_exclusions.json``, and less every layer that draws points. A
layer draws points when every symbol its renderer holds is a
``CIMPointSymbol``; the CIM of a layer names no geometry type, and a
renderer with no symbols or mixed ones leaves the layer in. Nothing about a
choice is kept: every build starts from the uploaded project and the pattern
file.
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
_TILEABLE = "CIMFeatureLayer"
"""The one kind of layer a vector tile package takes. A visible Graphics Layer fails the index with ERROR 001852."""


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
class LayerSource:
    """Where a feature layer reads its features: the workspace's last path segment and the dataset in it."""

    database: str
    """``JRShinjukuSta.gdb`` for a geodatabase, the folder's name for shapefiles."""
    dataset: str
    """A feature class name, or ``Space.shp``."""


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
    draws_points: bool
    """A layer whose renderer draws only point symbols. False for a group, and when the renderer does not say."""
    tiled_by_default: bool
    """A layer: matched by no pattern, its own or a group's above it, and not drawing points. A group: any layer in it is."""
    children: tuple[LayerNode, ...]
    source: LayerSource | None = None
    """A layer's own data source; None for a group, a join, or a connection the CIM does not spell out."""


@dataclass(frozen=True, slots=True)
class MapLayers:
    id: str
    """The ``CIMPATH=`` reference ``GISProject.json`` gives the map, which is also its ``uRI``."""
    name: str
    layers: tuple[LayerNode, ...]
    """Top of the drawing order first, as Pro's Contents pane lists them."""


def layer_count(the_map: MapLayers) -> int:
    """Layers, not groups: a map whose groups hold nothing has nothing to tile."""
    return sum(1 for node, _ in walk(the_map.layers) if not node.group)


DefaultReason = Literal["only_with_layers", "most_layers", "first_of_most"]


class SelectionError(ValueError):
    def __init__(self, message: str, kind: Literal["unknown_map", "empty_map", "layers"]) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True, slots=True)
class ProjectMaps:
    maps: tuple[MapLayers, ...]
    """Every map, in project order; those without a layer are listed but cannot be chosen."""
    default_map: str
    default_reason: DefaultReason
    state: Literal["maps"] = "maps"

    def chosen(self, map_id: str | None) -> MapLayers:
        """The map ``map_id`` names, or with none, the default."""
        wanted = self.default_map if map_id is None else map_id
        the_map = next((m for m in self.maps if m.id == wanted), None)
        if the_map is None:
            names = ", ".join(f"{m.name} ({m.id})" for m in self.maps)
            raise SelectionError(f"The project has no map {wanted}; its maps are {names}.", "unknown_map")
        if layer_count(the_map) == 0:
            raise SelectionError(f"The map {the_map.name!r} has no layers to tile.", "empty_map")
        return the_map


@dataclass(frozen=True, slots=True)
class NoMapLayers:
    """No map in the project has a layer, so there is nothing to tile."""

    maps: tuple[str, ...]
    state: Literal["no_layers"] = "no_layers"


@dataclass(frozen=True, slots=True)
class LayersUnreadable:
    detail: str
    state: Literal["unreadable"] = "unreadable"


ProjectLayers = ProjectMaps | NoMapLayers | LayersUnreadable


def read_project_layers(project: bytes, exclusions: TileExclusions, *, max_bytes: int) -> ProjectLayers:
    """The layer tree of each of the project's maps. Reads only ``GISProject.json`` and the members the maps reach."""
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
        map_items = [item for item in items or [] if isinstance(item, dict) and item.get("itemType") == "Map"]
        maps = tuple(self.map(item.get("catalogPath")) for item in map_items)
        counts = [layer_count(m) for m in maps]
        most = max(counts, default=0)
        if most == 0:
            return NoMapLayers(maps=tuple(m.name for m in maps))
        reason: DefaultReason = (
            "only_with_layers"
            if sum(1 for count in counts if count > 0) == 1
            else "most_layers"
            if counts.count(most) == 1
            else "first_of_most"
        )
        return ProjectMaps(maps=maps, default_map=maps[counts.index(most)].id, default_reason=reason)

    def map(self, uri: Any) -> MapLayers:
        doc = self.document(_member(uri))
        self.opened = set()
        return MapLayers(id=uri, name=str(doc.get("name", "")), layers=self.layers(doc, inherited=None))

    def layers(self, parent: dict[str, Any], *, inherited: str | None) -> tuple[LayerNode, ...]:
        uris = parent.get("layers")
        if not isinstance(uris, list):
            raise _Unreadable(f"{parent.get('name')!r} lists its layers in an unknown form")
        nodes = (self.node(uri, inherited=inherited) for uri in uris)
        return tuple(node for node in nodes if node is not None)

    def node(self, uri: Any, *, inherited: str | None) -> LayerNode | None:
        """None for a layer no tile package can hold; the worker switches off whatever the plan leaves out."""
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
            children = self.layers(doc, inherited=excluded_by or inherited)
            tiled = any(child.tiled_by_default for child in children)
            return LayerNode(uri, name, True, visible, excluded_by, False, tiled, children)
        if doc.get("type") != _TILEABLE:
            return None
        points = _symbol_types(doc.get("renderer")) == {"CIMPointSymbol"}
        tiled = excluded_by is None and inherited is None and not points
        return LayerNode(uri, name, False, visible, excluded_by, points, tiled, (), _layer_source(doc))


_SYMBOLS = frozenset({"CIMPointSymbol", "CIMLineSymbol", "CIMPolygonSymbol", "CIMMeshSymbol", "CIMTextSymbol"})


def _symbol_types(cim: Any) -> set[str]:
    """The types of the outermost symbols in ``cim``: a marker inside a polygon symbol is part of the polygon."""
    if isinstance(cim, dict):
        if cim.get("type") in _SYMBOLS:
            return {cim["type"]}
        return set().union(*map(_symbol_types, cim.values()))
    if isinstance(cim, list):
        return set().union(*map(_symbol_types, cim))
    return set()


def _layer_source(doc: dict[str, Any]) -> LayerSource | None:
    table = doc.get("featureTable")
    connection = table.get("dataConnection") if isinstance(table, dict) else None
    if not isinstance(connection, dict):
        return None
    workspace, dataset = connection.get("workspaceConnectionString"), connection.get("dataset")
    if not isinstance(workspace, str) or not isinstance(dataset, str) or not dataset:
        return None
    database = next(
        (value for key, _, value in (part.partition("=") for part in workspace.split(";")) if key.strip().upper() == "DATABASE"),
        "",
    )
    folder = database.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
    return LayerSource(database=folder, dataset=dataset) if folder else None


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


def default_selection(the_map: MapLayers) -> frozenset[str]:
    return frozenset(node.uri for node, _ in walk(the_map.layers) if not node.group and node.tiled_by_default)


@dataclass(frozen=True, slots=True)
class LayerVisibility:
    """One line of what the worker sets before tiling."""

    uri: str
    name: str
    """arcpy's ``longName``, for the log."""
    group: bool
    visible: bool


@dataclass(frozen=True, slots=True)
class TilePlan:
    """What the worker is told: the map to tile and the visibility to tile it with."""

    map_uri: str
    map_name: str
    """For the log, and to find the map by when arcpy gives no ``uRI``."""
    layers: tuple[LayerVisibility, ...]


def tile_plan(maps: ProjectMaps, map_id: str | None, selected: Collection[str] | None) -> TilePlan:
    """The chosen map, or the default, with the ``selected`` layers drawn, or that map's defaults."""
    the_map = maps.chosen(map_id)
    layers = visibility_plan(the_map, default_selection(the_map) if selected is None else selected)
    return TilePlan(map_uri=the_map.id, map_name=the_map.name, layers=layers)


def visibility_plan(the_map: MapLayers, selected: Collection[str]) -> tuple[LayerVisibility, ...]:
    """The visibility of every layer and group so that exactly the ``selected`` layers are drawn.

    A group is switched on when any layer in it is selected and off otherwise,
    whatever the project saved.
    """
    nodes = {node.uri: (node, long_name) for node, long_name in walk(the_map.layers)}
    unknown = sorted(uri for uri in selected if uri not in nodes)
    if unknown:
        raise SelectionError(f"These layers are not in the map {the_map.name!r}: {', '.join(unknown)}", "layers")
    groups = sorted(nodes[uri][1] for uri in selected if nodes[uri][0].group)
    if groups:
        raise SelectionError(f"Choose layers, not groups: {', '.join(groups)}", "layers")
    if not selected:
        raise SelectionError("Choose at least one layer to tile.", "layers")
    chosen = set(selected)

    def drawn(node: LayerNode) -> bool:
        return any(drawn(child) for child in node.children) if node.group else node.uri in chosen

    return tuple(
        LayerVisibility(uri=node.uri, name=long_name, group=node.group, visible=drawn(node))
        for node, long_name in walk(the_map.layers)
    )
