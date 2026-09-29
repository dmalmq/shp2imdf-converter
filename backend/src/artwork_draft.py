"""The placement draft an artwork project resumes from.

``placement.json`` beside a conversion holds the last placement the page sent:
the work (frame, per-floor transforms, pins, control points, output settings)
and the view it was done in (active floor, mode, tab, station pin, located
place, which reference layers were loaded). References are stored by identity
only; their geometry is re-queried from the pin.

Only a change to the work is an edit of the project. A view change is saved so
a reload lands where the user was, but it does not move ``content_changed_at``,
so opening a project, switching floors or tabs never makes a delivery stale.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StringConstraints, model_validator

DRAFT_VERSION = 1
MAX_DRAFT_BYTES = 1024 * 1024
MAX_FLOORS = 64
MAX_CONTROL_POINTS = 100
MAX_LAYER_NAMES = 64
MAX_CANDIDATES = 10

_Lng = Annotated[float, Field(ge=-180, le=180)]
_Lat = Annotated[float, Field(ge=-90, le=90)]
LngLat = tuple[_Lng, _Lat]
ArtworkPoint = tuple[FiniteFloat, FiniteFloat]
ArtworkBounds = tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]
_Scale = Annotated[FiniteFloat, Field(gt=0)]
_Label = Annotated[str, StringConstraints(min_length=1, max_length=40)]
_Crs = Annotated[str, StringConstraints(min_length=1, max_length=40)]
_Text = Annotated[str, StringConstraints(max_length=300)]
_Names = Annotated[list[_Text], Field(max_length=MAX_LAYER_NAMES)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DraftControlPoint(_Strict):
    id: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    artwork: ArtworkPoint
    map: LngLat


class DraftPose(_Strict):
    artwork_anchor: ArtworkPoint
    map_anchor: LngLat
    rotation_deg: FiniteFloat
    metres_per_point: _Scale


class PointsBasis(_Strict):
    """A fit to the pairs ``point_ids`` on ``floor``."""

    kind: Literal["points"]
    floor: _Label
    point_ids: Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=64)]], Field(max_length=MAX_CONTROL_POINTS)]


class ReferenceIdentity(_Strict):
    """Reference data by identity, since its geometry is not stored.

    The layer matched, the sources loaded (駅データ and uploaded file names) and
    the station pin 駅データ was queried around.
    """

    layer: _Text
    preloaded: bool
    uploads: _Names = []
    pin: LngLat | None = None


class ReferenceBasis(_Strict):
    """A shape match or snap against reference data."""

    kind: Literal["reference"]
    reference: ReferenceIdentity


class FloorBasis(_Strict):
    """A match to another floor, where that floor was at the time."""

    kind: Literal["floor"]
    floor: _Label
    pose: DraftPose


class DraftAlignment(_Strict):
    """The pose an accepted alignment left a floor at; the status is derived from it."""

    pose: DraftPose
    basis: Annotated[PointsBasis | ReferenceBasis | FloorBasis, Field(discriminator="kind")]


class DraftFloor(_Strict):
    label: _Label
    linked: bool
    pinned: bool
    artwork_anchor: ArtworkPoint
    map_anchor: LngLat
    artwork_bounds: ArtworkBounds
    rotation_deg: FiniteFloat | None = None
    metres_per_point: _Scale | None = None
    artwork_match: bool = False
    control_points: Annotated[list[DraftControlPoint], Field(max_length=MAX_CONTROL_POINTS)] = []
    alignment: DraftAlignment | None = None


class DraftFrame(_Strict):
    rotation_deg: FiniteFloat
    metres_per_point: _Scale
    working_crs: _Crs


class DraftFormats(_Strict):
    geopackage: bool
    shapefile: bool
    qgis: bool


class DraftPlacement(_Strict):
    frame: DraftFrame
    floors: Annotated[list[DraftFloor], Field(min_length=1, max_length=MAX_FLOORS)]
    scale_locked: bool
    output_crs: _Crs
    formats: DraftFormats

    @model_validator(mode="after")
    def _unique_labels(self) -> DraftPlacement:
        labels = [floor.label for floor in self.floors]
        if len(set(labels)) != len(labels):
            raise ValueError("Floor labels must be unique.")
        return self


class DraftPlace(_Strict):
    name: _Text
    lng_lat: LngLat
    working_crs: _Crs | None = None


class DraftLocation(_Strict):
    """Where the locate control landed: a filename guess or a place the user chose."""

    kind: Literal["guessed", "chosen"]
    query: _Text
    place: DraftPlace
    candidates: Annotated[list[DraftPlace], Field(min_length=1, max_length=MAX_CANDIDATES)]


class DraftLookupFailure(_Strict):
    """The filename lookup found nothing, or could not be asked; nothing was moved."""

    kind: Literal["not-found", "unavailable"]
    query: _Text


class DraftReferences(_Strict):
    """What was loaded, by identity: uploaded files cannot be re-read, only named."""

    preloaded: bool = False
    include_lines: bool = False
    hidden: _Names = []
    removed: _Names = []
    uploads: _Names = []


class DraftView(_Strict):
    active_floor_label: _Label | None = None
    mode: Literal["group", "individual"] = "group"
    tab: Literal["fit", "reference", "export"] = "fit"
    station_pin: LngLat | None = None
    location: Annotated[
        DraftLocation | DraftLookupFailure, Field(union_mode="left_to_right")
    ] | None = None
    references: DraftReferences = DraftReferences()


class PlacementDraft(_Strict):
    version: Literal[1]
    placement: DraftPlacement
    view: DraftView


class SaveDraftRequest(_Strict):
    base_revision: Annotated[int, Field(ge=0)]
    draft: PlacementDraft
    # The page's starting placement, before any edit; see ``ConversionStore.save_draft``.
    baseline: bool = False


@dataclass(frozen=True, slots=True)
class StoredDraft:
    revision: int
    draft: PlacementDraft | None


def canonical(model: BaseModel) -> str:
    """The model as sorted, compact JSON: equal text is equal content."""
    return json.dumps(
        model.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


# About 0.1 mm on the ground; frontend/src/lib/floorStatus.ts uses the same.
_DEGREES = 1e-9
_RELATIVE = 1e-9


def _pose(frame: DraftFrame, floor: DraftFloor) -> DraftPose:
    """The floor's resolved pose: a linked, unpinned floor takes the frame's rotation and scale."""
    own = not floor.linked or floor.pinned
    rotation = floor.rotation_deg if own and floor.rotation_deg is not None else frame.rotation_deg
    scale = floor.metres_per_point if own and floor.metres_per_point is not None else frame.metres_per_point
    return DraftPose(
        artwork_anchor=floor.artwork_anchor,
        map_anchor=floor.map_anchor,
        rotation_deg=rotation,
        metres_per_point=scale,
    )


def _same_pose(a: DraftPose, b: DraftPose) -> bool:
    def near(x: float, y: float, tolerance: float) -> bool:
        return abs(x - y) <= tolerance

    return (
        near(a.map_anchor[0], b.map_anchor[0], _DEGREES)
        and near(a.map_anchor[1], b.map_anchor[1], _DEGREES)
        and near(a.artwork_anchor[0], b.artwork_anchor[0], _RELATIVE * max(1.0, abs(b.artwork_anchor[0])))
        and near(a.artwork_anchor[1], b.artwork_anchor[1], _RELATIVE * max(1.0, abs(b.artwork_anchor[1])))
        and near(a.rotation_deg, b.rotation_deg, _DEGREES)
        and near(a.metres_per_point, b.metres_per_point, _RELATIVE * b.metres_per_point)
    )


def _same_pin(a: tuple[float, float] | None, b: tuple[float, float] | None) -> bool:
    if a is None or b is None:
        return a is b
    return abs(a[0] - b[0]) <= _DEGREES and abs(a[1] - b[1]) <= _DEGREES


def _same_reference(identity: ReferenceIdentity, view: DraftView) -> bool:
    """The reference an alignment used is still the one loaded, queried around the same pin."""
    loaded = view.references
    return (
        identity.layer not in loaded.removed
        and identity.preloaded == loaded.preloaded
        and sorted(identity.uploads) == sorted(loaded.uploads)
        and _same_pin(identity.pin, view.station_pin)
    )


def floor_is_aligned(draft: PlacementDraft, floor: DraftFloor) -> bool:
    """Still where an accepted alignment put it, against a basis that has not changed.

    ``frontend/src/lib/floorStatus.ts`` applies the same rule; the shared
    ``floor_status_golden.json`` fixture holds both to it.
    """
    placement = draft.placement
    alignment = floor.alignment
    if alignment is None or not _same_pose(_pose(placement.frame, floor), alignment.pose):
        return False
    basis = alignment.basis
    by_label = {item.label: item for item in placement.floors}
    if isinstance(basis, FloorBasis):
        reference = by_label.get(basis.floor)
        return reference is not None and _same_pose(_pose(placement.frame, reference), basis.pose)
    if isinstance(basis, PointsBasis):
        owner = by_label.get(basis.floor)
        return owner is not None and [p.id for p in owner.control_points] == basis.point_ids
    return _same_reference(basis.reference, draft.view)


def placed_floor_count(draft: PlacementDraft) -> int:
    """Floors whose status is Aligned; moving or pinning a floor does not count."""
    return sum(1 for floor in draft.placement.floors if floor_is_aligned(draft, floor))
