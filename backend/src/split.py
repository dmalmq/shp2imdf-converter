"""Split one brought-in import into a project per building.

A building is a drawn shape, a set of picked files, or both. A source row of
a picked file goes to the building that picked it, and a file may be picked
by one building only. Any other row belongs to the drawn shape that contains
its centroid, the same rule the Illustrator floor boxes use. Shapes may not
overlap, so a row has at most one owner; rows that go to no building stay
behind. A row is assigned whole, all its parts together.

Files are picked one by one or by group: a geodatabase's feature datasets,
and the group layers of an ``.aprx`` that came with the import, read from
its CIM without arcpy and matched to the import's files by data source.
"""

from __future__ import annotations

import copy
import shutil
from collections import Counter
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shapely import make_valid
from shapely.geometry import GeometryCollection, shape
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from backend.src.detector import sync_feature_types
from backend.src.importer import rebuild_normalized_feature_collection
from backend.src.schemas import (
    ImportedFile,
    LayerGroup,
    SessionRecord,
    SplitOrigin,
    SplitPreviewResponse,
    SplitShape,
    SplitShapeCounts,
)
from backend.src.session import SessionManager
from backend.src.tile_layers import NO_EXCLUSIONS, LayerNode, LayerSource, ProjectMaps, read_project_layers, walk
from backend.src.upload_tree import gdb_root


@dataclass(frozen=True)
class SplitAssignment:
    names: list[str]
    # One list of source features per shape, in the order the shapes were given.
    features: list[list[dict[str, Any]]]
    unassigned: list[dict[str, Any]]


def _parse_shapes(shapes: list[SplitShape], stems: Collection[str]) -> tuple[list[BaseGeometry | None], dict[str, int]]:
    """Each building's polygon, None for one defined by files alone, and the building each picked file goes to."""
    if not shapes:
        raise ValueError("Draw or pick at least one building to split by.")
    names = [item.name.strip() for item in shapes]
    if any(not name for name in names):
        raise ValueError("Every building needs a name.")
    if len(set(names)) != len(names):
        raise ValueError("Building names must be different from each other.")

    polygons: list[BaseGeometry | None] = []
    for name, item in zip(names, shapes):
        if item.polygon is None:
            if not item.files:
                raise ValueError(f"“{name}” has neither a shape nor picked layers.")
            polygons.append(None)
            continue
        if item.polygon.get("type") != "Polygon":
            raise ValueError(f"“{name}” is not a polygon.")
        try:
            polygon = make_valid(shape(item.polygon))
        except (ValueError, TypeError, IndexError) as error:
            raise ValueError(f"“{name}” is not a readable polygon.") from error
        if polygon.is_empty or polygon.area <= 0:
            raise ValueError(f"“{name}” has no area; draw at least three corners.")
        polygons.append(polygon)

    drawn = [(index, polygon) for index, polygon in enumerate(polygons) if polygon is not None]
    for position, (i, first) in enumerate(drawn):
        for j, second in drawn[position + 1 :]:
            if first.intersection(second).area > 0:
                raise ValueError(f"“{names[i]}” and “{names[j]}” overlap; a feature can only go to one building.")

    known = set(stems)
    picked: dict[str, int] = {}
    for index, item in enumerate(shapes):
        for stem in item.files:
            if stem not in known:
                raise ValueError(f"“{names[index]}” picks {stem}, which is not a file of this import.")
            owner = picked.setdefault(stem, index)
            if owner != index:
                raise ValueError(f"{stem} is picked by both “{names[owner]}” and “{names[index]}”; a file can only go to one building.")
    return polygons, picked


def _row_key(feature: dict[str, Any], index: int) -> tuple[Any, ...]:
    properties = feature.get("properties") or {}
    stem, row = properties.get("source_file"), properties.get("source_row_index")
    return ("row", stem, row) if isinstance(stem, str) and isinstance(row, int) else ("feature", index)


def _centroid(features: list[dict[str, Any]]) -> BaseGeometry | None:
    parts = []
    for feature in features:
        if not feature.get("geometry"):
            continue
        try:
            parts.append(shape(feature["geometry"]))
        except (ValueError, TypeError, IndexError):
            continue
    if not parts:
        return None
    centroid = GeometryCollection(parts).centroid
    return None if centroid.is_empty else centroid


def assign_features(
    source_collection: dict[str, Any], shapes: list[SplitShape], stems: Collection[str]
) -> SplitAssignment:
    """Assign each source row, with all its parts: to the building that picked its file, else to the shape holding its centroid.

    The importer turns a multipart row into one feature per part; a row is kept
    whole so the round-trip shapefile export can give each building whole rows.
    ``stems`` are the import's files, which picks must name.
    """
    parsed, picked = _parse_shapes(shapes, stems)
    polygons = [(index, prep(polygon)) for index, polygon in enumerate(parsed) if polygon is not None]
    rows: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for index, feature in enumerate(source_collection.get("features") or []):
        rows.setdefault(_row_key(feature, index), []).append(feature)

    buckets: list[list[dict[str, Any]]] = [[] for _ in shapes]
    unassigned: list[dict[str, Any]] = []
    for parts in rows.values():
        owner = picked.get(str((parts[0].get("properties") or {}).get("source_file") or ""))
        if owner is None and polygons and (centroid := _centroid(parts)) is not None:
            owner = next((index for index, polygon in polygons if polygon.covers(centroid)), None)
        (buckets[owner] if owner is not None else unassigned).extend(parts)
    return SplitAssignment(names=[item.name.strip() for item in shapes], features=buckets, unassigned=unassigned)


def _counts_by_file(features: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(str((feature.get("properties") or {}).get("source_file") or "") for feature in features)
    return dict(sorted(counts.items()))


def preview_split(record: SessionRecord, shapes: list[SplitShape]) -> SplitPreviewResponse:
    assignment = assign_features(source_collection(record), shapes, [item.stem for item in record.files])
    return SplitPreviewResponse(
        shapes=[
            SplitShapeCounts(name=name, total=len(features), files=_counts_by_file(features))
            for name, features in zip(assignment.names, assignment.features)
        ],
        unassigned_total=len(assignment.unassigned),
        unassigned=_counts_by_file(assignment.unassigned),
        owners={
            str(ref): index
            for index, features in enumerate(assignment.features)
            for feature in features
            if (ref := (feature.get("properties") or {}).get("source_feature_ref"))
        },
    )


def source_collection(record: SessionRecord) -> dict[str, Any]:
    """What a split assigns: the features as brought in, before Set up or any edit."""
    return record.source_feature_collection or record.feature_collection


def _copy_source_files(parent: SessionRecord, stems: set[str], target: Path) -> Path | None:
    """Copy the parent's uploaded files for these stems, byte for byte.

    Each project owns its upload folder and deletes it when it goes, so a child
    cannot borrow the parent's. Rows of other buildings stay in the copies; the
    shapefile export leaves them out.
    """
    source = Path(parent.upload_artifact_dir) if parent.upload_artifact_dir else None
    if source is None or not source.is_dir():
        return None
    target.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_file() and entry.stem in stems:
            shutil.copy2(entry, target / entry.name)
    return target


def _create_child(
    manager: SessionManager,
    parent: SessionRecord,
    name: str,
    features: list[dict[str, Any]],
    uploads_root: Path,
) -> SessionRecord:
    counts = _counts_by_file(features)
    files = [
        item.model_copy(update={"feature_count": counts[item.stem]}, deep=True)
        for item in parent.files
        if item.stem in counts
    ]
    source = sync_feature_types({"type": "FeatureCollection", "features": copy.deepcopy(features)}, files)
    normalized, files, _ = rebuild_normalized_feature_collection(source, files)
    child = manager.create_session(
        files=files,
        cleanup_summary=parent.cleanup_summary,
        feature_collection=normalized,
        source_feature_collection=source,
        warnings=list(parent.warnings),
        learned_keywords=dict(parent.learned_keywords),
    )
    child.split_from = SplitOrigin(parent_session_id=parent.session_id, name=name)
    target = uploads_root / child.session_id
    # Set before copying, so a failed copy is cleaned up with the child.
    child.upload_artifact_dir = str(target)
    try:
        if not _copy_source_files(parent, set(counts), target):
            child.upload_artifact_dir = None
        manager.save_session(child)
    except Exception:
        manager.delete_session(child)
        raise
    return child


def split_session(
    manager: SessionManager, parent: SessionRecord, shapes: list[SplitShape], uploads_root: Path
) -> tuple[list[SessionRecord], int]:
    """Create one new project per shape, and say how many features fell outside them all.

    The parent is read, never changed.
    """
    if parent.import_profile != "standard":
        raise ValueError("Only a shapefile, GeoPackage or geodatabase import can be split by building.")
    assignment = assign_features(source_collection(parent), shapes, [item.stem for item in parent.files])
    empty = [name for name, features in zip(assignment.names, assignment.features) if not features]
    if empty:
        raise ValueError(f"No features go to: {', '.join(empty)}.")

    children: list[SessionRecord] = []
    try:
        for name, features in zip(assignment.names, assignment.features):
            children.append(_create_child(manager, parent, name, features, uploads_root))
    except Exception:
        # A half-made split would list some buildings, and a retry would duplicate them.
        for child in children:
            manager.delete_session(child)
        raise
    return children, len(assignment.unassigned)


def layer_groups(record: SessionRecord) -> list[LayerGroup]:
    """The import's feature datasets, then the project's group layers."""
    datasets: dict[tuple[str, str], list[str]] = {}
    for item in record.files:
        if item.feature_dataset:
            datasets.setdefault((item.source_container or "", item.feature_dataset), []).append(item.stem)
    containers = {container for container, _ in datasets}
    return [
        LayerGroup(
            id=f"feature_dataset:{container}/{name}",
            name=f"{container} › {name}" if len(containers) > 1 else name,
            kind="feature_dataset",
            stems=stems,
        )
        for (container, name), stems in sorted(datasets.items())
    ] + list(record.project_groups)


def project_groups(blobs: Sequence[tuple[str, bytes]], files: Sequence[ImportedFile], *, max_bytes: int) -> list[LayerGroup]:
    """Every group layer of every map in the upload's ``.aprx`` files that holds a layer drawn from one of ``files``.

    A project that cannot be read gives no groups; the import does not need it.
    """
    maps = [
        the_map
        for name, content in blobs
        if name.lower().endswith(".aprx") and gdb_root(name.replace("\\", "/")) is None
        and isinstance(project := read_project_layers(content, NO_EXCLUSIONS, max_bytes=max_bytes), ProjectMaps)
        for the_map in project.maps
    ]
    found: list[tuple[str, str, str, list[str]]] = []
    for the_map in maps:
        for node, long_name in walk(the_map.layers):
            if not node.group:
                continue
            stems = list(dict.fromkeys(stem for layer in _layers_in(node) if (stem := _file_of(layer.source, files))))
            if stems:
                found.append((the_map.name, f"project_group:{the_map.id}:{node.uri}", long_name, stems))
    several_maps = len({map_name for map_name, *_ in found}) > 1
    return [
        LayerGroup(
            id=group_id,
            name=" › ".join(([map_name] if several_maps else []) + long_name.split("\\")),
            kind="project_group",
            stems=stems,
        )
        for map_name, group_id, long_name, stems in found
    ]


def _layers_in(node: LayerNode) -> list[LayerNode]:
    return [layer for child in node.children for layer in (_layers_in(child) if child.group else [child])]


def _file_of(source: LayerSource | None, files: Sequence[ImportedFile]) -> str | None:
    """The import's file a layer draws: the same feature class of a geodatabase of the same name, else the shapefile of that name."""
    if source is None:
        return None
    dataset = source.dataset.casefold()
    for item in files:
        if (
            item.source_format == "gdb"
            and (item.source_layer or "").casefold() == dataset
            and (item.source_container or "").casefold() == source.database.casefold()
        ):
            return item.stem
    shapefile = dataset.removesuffix(".shp")
    matches = [item for item in files if item.source_format == "shapefile" and item.stem.casefold() == shapefile]
    return matches[0].stem if len(matches) == 1 else None
