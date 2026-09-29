import type {
  DraftPlace,
  ExportFormatsPayload,
  PlacementDraft,
  ReferenceSelection
} from "../api/client";
import type { Located, Place } from "../components/illustrator/locateChrome";
import type { PlacementTab } from "../components/illustrator/PlacementSidebar";
import type { AdjustmentMode, PlacementState } from "../hooks/useIllustratorPlacement";

/** What the placement page keeps beside the reducer state, and saves with it. */
export type DraftView = {
  mode: AdjustmentMode;
  tab: PlacementTab;
  outputCrs: string;
  formats: ExportFormatsPayload;
  located: Located;
  references: ReferenceSelection;
};

export const NO_REFERENCES: ReferenceSelection = {
  preloaded: false,
  include_lines: false,
  hidden: [],
  removed: [],
  uploads: []
};

/** The server's bounds (`artwork_draft.py`); text past them is clipped, not refused. */
const TEXT_LIMIT = 300;
const NAME_LIMIT = 64;
const CANDIDATE_LIMIT = 10;

const clip = (text: string) => text.slice(0, TEXT_LIMIT);
const clipNames = (names: string[]) => names.slice(0, NAME_LIMIT).map(clip);

function toPlace(place: Place): DraftPlace {
  return {
    name: clip(place.name),
    lng_lat: [place.lngLat[0], place.lngLat[1]],
    working_crs: place.workingCrs ?? null
  };
}

function fromPlace(place: DraftPlace): Place {
  return {
    name: place.name,
    lngLat: [place.lng_lat[0], place.lng_lat[1]],
    ...(place.working_crs ? { workingCrs: place.working_crs } : {})
  };
}

function toLocation(located: Located): PlacementDraft["view"]["location"] {
  if (located.kind !== "guessed" && located.kind !== "chosen") return null;
  return {
    kind: located.kind,
    query: clip(located.query),
    place: toPlace(located.place),
    candidates: located.candidates.slice(0, CANDIDATE_LIMIT).map(toPlace)
  };
}

function fromLocation(location: PlacementDraft["view"]["location"]): Located {
  if (!location || location.candidates.length === 0) return { kind: "none" };
  const [first, ...rest] = location.candidates.map(fromPlace);
  return {
    kind: location.kind,
    query: location.query,
    place: fromPlace(location.place),
    candidates: [first, ...rest]
  };
}

export function toDraft(state: PlacementState, view: DraftView): PlacementDraft {
  return {
    version: 1,
    placement: {
      frame: {
        rotation_deg: state.frame.rotationDeg,
        metres_per_point: state.frame.metresPerPoint,
        working_crs: state.frame.workingCrs
      },
      floors: state.floors.map((floor) => ({
        label: floor.label,
        linked: floor.linked,
        pinned: floor.pinned,
        artwork_anchor: [floor.artworkAnchor[0], floor.artworkAnchor[1]],
        map_anchor: [floor.mapAnchor[0], floor.mapAnchor[1]],
        artwork_bounds: [...floor.artworkBounds],
        rotation_deg: floor.rotationDeg ?? null,
        metres_per_point: floor.metresPerPoint ?? null,
        artwork_match: floor.artworkMatch ?? false,
        control_points: floor.controlPoints.map((point) => ({
          id: point.id,
          artwork: [point.artwork[0], point.artwork[1]],
          map: [point.map[0], point.map[1]]
        }))
      })),
      scale_locked: state.scaleLocked,
      output_crs: view.outputCrs,
      formats: { ...view.formats }
    },
    view: {
      active_floor_label: state.activeFloorLabel,
      mode: view.mode,
      tab: view.tab,
      station_pin: state.stationPin ? [state.stationPin[0], state.stationPin[1]] : null,
      location: toLocation(view.located),
      references: {
        preloaded: view.references.preloaded,
        include_lines: view.references.include_lines,
        hidden: clipNames(view.references.hidden),
        removed: clipNames(view.references.removed),
        uploads: clipNames(view.references.uploads)
      }
    }
  };
}

export function fromDraft(draft: PlacementDraft): { state: PlacementState; view: DraftView } {
  const { placement, view } = draft;
  return {
    state: {
      frame: {
        rotationDeg: placement.frame.rotation_deg,
        metresPerPoint: placement.frame.metres_per_point,
        workingCrs: placement.frame.working_crs
      },
      floors: placement.floors.map((floor) => ({
        label: floor.label,
        linked: floor.linked,
        pinned: floor.pinned,
        artworkAnchor: [floor.artwork_anchor[0], floor.artwork_anchor[1]],
        mapAnchor: [floor.map_anchor[0], floor.map_anchor[1]],
        artworkBounds: [...floor.artwork_bounds],
        controlPoints: floor.control_points.map((point) => ({
          id: point.id,
          artwork: [point.artwork[0], point.artwork[1]],
          map: [point.map[0], point.map[1]]
        })),
        ...(floor.rotation_deg === null ? {} : { rotationDeg: floor.rotation_deg }),
        ...(floor.metres_per_point === null ? {} : { metresPerPoint: floor.metres_per_point }),
        ...(floor.artwork_match ? { artworkMatch: true } : {})
      })),
      activeFloorLabel: view.active_floor_label,
      scaleLocked: placement.scale_locked,
      stationPin: view.station_pin ? [view.station_pin[0], view.station_pin[1]] : null
    },
    view: {
      mode: view.mode,
      tab: view.tab,
      outputCrs: placement.output_crs,
      formats: { ...placement.formats },
      located: fromLocation(view.location),
      references: { ...NO_REFERENCES, ...view.references }
    }
  };
}
