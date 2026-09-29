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
    location: DraftLocation | None = None
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


def placed_floor_count(placement: DraftPlacement) -> int:
    """Floors pinned, or holding enough pairs for a fit (two with the scale locked, else three)."""
    needed = 2 if placement.scale_locked else 3
    return sum(
        1 for floor in placement.floors if floor.pinned or len(floor.control_points) >= needed
    )
