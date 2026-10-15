"""Split one brought-in import into a project per building.

A feature belongs to the drawn shape that contains its centroid, the same
rule the Illustrator floor boxes use. Shapes may not overlap, so a feature
has at most one owner; features outside every shape stay behind.
"""

from __future__ import annotations

import copy
import shutil
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shapely import make_valid
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry
from shapely.prepared import prep

from backend.src.detector import sync_feature_types
from backend.src.importer import rebuild_normalized_feature_collection
from backend.src.schemas import (
    SessionRecord,
    SplitOrigin,
    SplitPreviewResponse,
    SplitShape,
    SplitShapeCounts,
)
from backend.src.session import SessionManager


@dataclass(frozen=True)
class SplitAssignment:
    names: list[str]
    # One list of source features per shape, in the order the shapes were given.
    features: list[list[dict[str, Any]]]
    unassigned: list[dict[str, Any]]


def _parse_shapes(shapes: list[SplitShape]) -> list[BaseGeometry]:
    if not shapes:
        raise ValueError("Draw at least one building to split by.")
    names = [item.name.strip() for item in shapes]
    if any(not name for name in names):
        raise ValueError("Every building needs a name.")
    if len(set(names)) != len(names):
        raise ValueError("Building names must be different from each other.")

    polygons: list[BaseGeometry] = []
    for name, item in zip(names, shapes):
        if item.polygon.get("type") != "Polygon":
            raise ValueError(f"“{name}” is not a polygon.")
        try:
            polygon = make_valid(shape(item.polygon))
        except (ValueError, TypeError, IndexError) as error:
            raise ValueError(f"“{name}” is not a readable polygon.") from error
        if polygon.is_empty or polygon.area <= 0:
            raise ValueError(f"“{name}” has no area; draw at least three corners.")
        polygons.append(polygon)

    for i, first in enumerate(polygons):
        for j in range(i + 1, len(polygons)):
            if first.intersection(polygons[j]).area > 0:
                raise ValueError(f"“{names[i]}” and “{names[j]}” overlap; a feature can only go to one building.")
    return polygons


def assign_features(source_collection: dict[str, Any], shapes: list[SplitShape]) -> SplitAssignment:
    polygons = [prep(polygon) for polygon in _parse_shapes(shapes)]
    buckets: list[list[dict[str, Any]]] = [[] for _ in polygons]
    unassigned: list[dict[str, Any]] = []
    for feature in source_collection.get("features") or []:
        geometry = feature.get("geometry")
        owner = None
        if geometry:
            try:
                centroid = shape(geometry).centroid
            except (ValueError, TypeError, IndexError):
                centroid = None
            if centroid is not None and not centroid.is_empty:
                owner = next((index for index, polygon in enumerate(polygons) if polygon.covers(centroid)), None)
        (buckets[owner] if owner is not None else unassigned).append(feature)
    return SplitAssignment(names=[item.name.strip() for item in shapes], features=buckets, unassigned=unassigned)


def _counts_by_file(features: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(str((feature.get("properties") or {}).get("source_file") or "") for feature in features)
    return dict(sorted(counts.items()))


def preview_split(source_collection: dict[str, Any], shapes: list[SplitShape]) -> SplitPreviewResponse:
    assignment = assign_features(source_collection, shapes)
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


def _source_collection(record: SessionRecord) -> dict[str, Any]:
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


def split_session(
    manager: SessionManager, parent: SessionRecord, shapes: list[SplitShape], uploads_root: Path
) -> tuple[list[SessionRecord], int]:
    """Create one new project per shape, and say how many features fell outside them all.

    The parent is read, never changed.
    """
    if parent.import_profile != "standard":
        raise ValueError("Only a shapefile or GeoPackage import can be split by building.")
    assignment = assign_features(_source_collection(parent), shapes)
    empty = [name for name, features in zip(assignment.names, assignment.features) if not features]
    if empty:
        raise ValueError(f"No features fall inside: {', '.join(empty)}.")

    children: list[SessionRecord] = []
    for name, features in zip(assignment.names, assignment.features):
        counts = _counts_by_file(features)
        files = [
            item.model_copy(update={"feature_count": counts[item.stem]}, deep=True)
            for item in parent.files
            if item.stem in counts
        ]
        source = sync_feature_types(
            {"type": "FeatureCollection", "features": copy.deepcopy(features)},
            files,
        )
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
        copied = _copy_source_files(parent, set(counts), uploads_root / child.session_id)
        child.upload_artifact_dir = str(copied) if copied else None
        manager.save_session(child)
        children.append(child)
    return children, len(assignment.unassigned)
