import { useReducer } from "react";

import type { TransformPayload } from "../api/client";
import {
  enuToLngLat,
  fitHelmert,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
  type SimilarityTransform
} from "../lib/similarity";

/** Our Illustrator floor plans are authored at 1:1000. */
export const DEFAULT_DRAWING_SCALE = 1000;

/** Ground metres per PDF point at {@link DEFAULT_DRAWING_SCALE}. */
export const DEFAULT_METRES_PER_POINT = metresPerPointForScale(DEFAULT_DRAWING_SCALE);

export type ControlPoint = {
  id: string;
  artwork: [number, number];
  /** WGS84 lon/lat. Converted to ENU only for the duration of a fit. */
  map: [number, number];
};

export type FloorPlacement = {
  label: string;
  /** True: scale/rotation follow the frame and the anchor is derived. */
  linked: boolean;
  artworkAnchor: [number, number];
  mapAnchor: [number, number];
  controlPoints: ControlPoint[];
  artworkBounds: [number, number, number, number];
  /** Own scale/rotation once unlinked; undefined while linked (frame is used). */
  rotationDeg?: number;
  metresPerPoint?: number;
};

export type PlacementState = {
  frame: { rotationDeg: number; metresPerPoint: number; workingCrs: string };
  floors: FloorPlacement[];
  activeFloorLabel: string | null;
  scaleLocked: boolean;
};

export type PlacementAction =
  /**
   * `baseline` marks the initial placement (located from the file name), which
   * becomes the state undo returns to rather than an undoable edit of its own.
   */
  | { type: "positionBuilding"; mapAnchor: [number, number]; baseline?: boolean }
  | { type: "dragFloor"; label: string; mapAnchor: [number, number] }
  | { type: "rotateFrame"; rotationDeg: number }
  | { type: "scaleFrame"; metresPerPoint: number }
  /** Per-floor transforms, used once a floor has been moved out of the frame. */
  | { type: "rotateFloor"; label: string; rotationDeg: number }
  | { type: "scaleFloor"; label: string; metresPerPoint: number }
  | { type: "setDrawingScale"; denominator: number }
  | { type: "calibrateDistance"; artworkDistance: number; realMetres: number }
  | { type: "unlockScale" }
  | { type: "unlockFloor"; label: string }
  | { type: "relinkFloor"; label: string }
  | { type: "setActiveFloor"; label: string }
  | { type: "setWorkingCrs"; workingCrs: string }
  | { type: "addControlPoint"; point: ControlPoint }
  | { type: "removeControlPoint"; id: string }
  | { type: "fitControlPoints" }
  | { type: "applyFloors"; floors: { label: string; transform: TransformPayload }[] }
  /** Install a whole new floor set (new file or new assignment), labels included. */
  | { type: "resetPlacement"; state: PlacementState }
  /** Closes the current drag so the next one is a separate undo step. */
  | { type: "endGesture" }
  | { type: "undo" }
  | { type: "redo" };

function normaliseRotation(degrees: number): number {
  const wrapped = ((degrees + 180) % 360) - 180;
  return wrapped <= -180 ? wrapped + 360 : wrapped;
}

/** The active floor's full transform, resolved from the frame when linked. */
export function resolvedTransform(
  state: PlacementState,
  floor: FloorPlacement
): SimilarityTransform {
  return {
    artworkAnchor: floor.artworkAnchor,
    mapAnchor: floor.mapAnchor,
    rotationDeg: floor.linked ? state.frame.rotationDeg : (floor.rotationDeg ?? state.frame.rotationDeg),
    metresPerPoint: floor.linked
      ? state.frame.metresPerPoint
      : (floor.metresPerPoint ?? state.frame.metresPerPoint),
    workingCrs: state.frame.workingCrs
  };
}

function activeFloor(state: PlacementState): FloorPlacement | null {
  return state.floors.find((f) => f.label === state.activeFloorLabel) ?? null;
}

/** Derived anchor: active anchor + the frame applied to the artwork offset. */
function deriveAnchor(state: PlacementState, floor: FloorPlacement): [number, number] {
  const active = activeFloor(state);
  if (!active) return floor.mapAnchor;
  const dx = floor.artworkAnchor[0] - active.artworkAnchor[0];
  const dy = floor.artworkAnchor[1] - active.artworkAnchor[1];
  const theta = (state.frame.rotationDeg * Math.PI) / 180;
  const s = state.frame.metresPerPoint;
  const east = s * (Math.cos(theta) * dx - Math.sin(theta) * dy);
  const north = s * (Math.sin(theta) * dx + Math.cos(theta) * dy);
  return enuToLngLat(east, north, active.mapAnchor[0], active.mapAnchor[1]);
}

function recomputeLinked(state: PlacementState): PlacementState {
  const active = activeFloor(state);
  if (!active) return state;
  return {
    ...state,
    floors: state.floors.map((f) =>
      f.label === active.label || !f.linked ? f : { ...f, mapAnchor: deriveAnchor(state, f) }
    )
  };
}

/** One full transform payload per floor, for the export request. */
export function toFloorPayloads(
  state: PlacementState
): { label: string; transform: TransformPayload }[] {
  return state.floors.map((f) => {
    const t = resolvedTransform(state, f);
    return {
      label: f.label,
      transform: {
        artwork_anchor: t.artworkAnchor,
        map_anchor: t.mapAnchor,
        rotation_deg: t.rotationDeg,
        metres_per_point: t.metresPerPoint,
        working_crs: t.workingCrs
      }
    };
  });
}

/** Rebuild state from a saved floor set; anchors and frame come from the save. */
export function floorPayloadsToState(
  floors: { label: string; transform: TransformPayload }[],
  current: PlacementState
): PlacementState {
  const active = floors[0]?.label ?? null;
  const frameTransform = floors.find((f) => f.label === active)?.transform;
  const byLabel = new Map(floors.map((f) => [f.label, f.transform]));
  return {
    frame: {
      rotationDeg: frameTransform?.rotation_deg ?? current.frame.rotationDeg,
      metresPerPoint: frameTransform?.metres_per_point ?? current.frame.metresPerPoint,
      workingCrs: frameTransform?.working_crs ?? current.frame.workingCrs
    },
    activeFloorLabel: active,
    scaleLocked: true,
    floors: current.floors.map((f) => {
      const saved = byLabel.get(f.label);
      return saved
        ? {
            ...f,
            linked: true,
            mapAnchor: [saved.map_anchor[0], saved.map_anchor[1]] as [number, number],
            rotationDeg: undefined,
            metresPerPoint: undefined,
            controlPoints: []
          }
        : f;
    })
  };
}

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case "positionBuilding": {
      const active = activeFloor(state);
      if (!active) return state;
      const moved = {
        ...state,
        floors: state.floors.map((f) =>
          f.label === active.label ? { ...f, mapAnchor: action.mapAnchor } : f
        )
      };
      return active.linked ? recomputeLinked(moved) : moved;
    }

    case "dragFloor": {
      const single = state.floors.length === 1;
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label
            ? single || !f.linked
              ? { ...f, mapAnchor: action.mapAnchor }
              : {
                  ...f,
                  mapAnchor: action.mapAnchor,
                  linked: false,
                  // Freeze the frame values into the floor now, so later frame
                  // operations cannot drag an independently-placed floor along.
                  rotationDeg: state.frame.rotationDeg,
                  metresPerPoint: state.frame.metresPerPoint
                }
            : f
        )
      };
    }

    case "rotateFloor": {
      const rotationDeg = normaliseRotation(action.rotationDeg);
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label ? { ...f, rotationDeg } : f
        )
      };
    }

    case "scaleFloor": {
      if (!(action.metresPerPoint > 0)) return state;
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label ? { ...f, metresPerPoint: action.metresPerPoint } : f
        )
      };
    }

    case "rotateFrame": {
      const rotationDeg = normaliseRotation(action.rotationDeg);
      if (!state.floors.some((f) => f.linked)) return state;
      return recomputeLinked({ ...state, frame: { ...state.frame, rotationDeg } });
    }

    case "scaleFrame": {
      if (state.scaleLocked || !(action.metresPerPoint > 0)) return state;
      return recomputeLinked({
        ...state,
        frame: { ...state.frame, metresPerPoint: action.metresPerPoint }
      });
    }

    case "setDrawingScale": {
      if (!(action.denominator > 0)) return state;
      return recomputeLinked({
        ...state,
        scaleLocked: true,
        frame: { ...state.frame, metresPerPoint: metresPerPointForScale(action.denominator) }
      });
    }

    case "calibrateDistance": {
      if (!(action.artworkDistance > 0) || !(action.realMetres > 0)) return state;
      return recomputeLinked({
        ...state,
        scaleLocked: true,
        frame: { ...state.frame, metresPerPoint: action.realMetres / action.artworkDistance }
      });
    }

    case "unlockScale":
      return { ...state, scaleLocked: false };

    case "setWorkingCrs":
      return { ...state, frame: { ...state.frame, workingCrs: action.workingCrs } };

    case "unlockFloor":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label
            ? {
                ...f,
                linked: false,
                rotationDeg: state.frame.rotationDeg,
                metresPerPoint: state.frame.metresPerPoint
              }
            : f
        )
      };

    case "relinkFloor": {
      const floor = state.floors.find((f) => f.label === action.label);
      if (!floor || floor.linked) return state;
      const linked = {
        ...floor,
        linked: true,
        rotationDeg: undefined,
        metresPerPoint: undefined
      };
      return recomputeLinked({
        ...state,
        floors: state.floors.map((f) => (f.label === action.label ? linked : f))
      });
    }

    case "setActiveFloor":
      return { ...state, activeFloorLabel: action.label };

    case "addControlPoint":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === state.activeFloorLabel
            ? { ...f, controlPoints: [...f.controlPoints, action.point] }
            : f
        )
      };

    case "removeControlPoint":
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === state.activeFloorLabel
            ? { ...f, controlPoints: f.controlPoints.filter((p) => p.id !== action.id) }
            : f
        )
      };

    case "fitControlPoints": {
      const active = activeFloor(state);
      if (!active || active.controlPoints.length < 2) return state;
      const [lon0, lat0] = active.mapAnchor;
      const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
      const fitted = fitHelmert(
        active.controlPoints.map((p) => p.artwork),
        enu,
        state.frame.workingCrs,
        active.linked && state.scaleLocked ? state.frame.metresPerPoint : undefined
      );
      const [lon, lat] = enuToLngLat(fitted.mapAnchor[0], fitted.mapAnchor[1], lon0, lat0);
      const single = state.floors.length === 1;
      if (single) {
        // One floor: the fit applies through the frame and the floor stays
        // linked, preserving the single-floor behaviour.
        return {
          ...state,
          frame: {
            ...state.frame,
            rotationDeg: fitted.rotationDeg,
            metresPerPoint: state.scaleLocked
              ? state.frame.metresPerPoint
              : fitted.metresPerPoint
          },
          floors: state.floors.map((f) =>
            f.label === active.label ? { ...f, mapAnchor: [lon, lat] } : f
          )
        };
      }
      // Multi-floor: the fit owns this floor's full transform, including its
      // own anchor; keeping the region-centroid anchor would make residuals
      // wrong. The floor unlinks so the frame never fights the fit.
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === active.label
            ? {
                ...f,
                linked: false,
                artworkAnchor: [fitted.artworkAnchor[0], fitted.artworkAnchor[1]],
                mapAnchor: [lon, lat],
                rotationDeg: fitted.rotationDeg,
                metresPerPoint: fitted.metresPerPoint
              }
            : f
        )
      };
    }

    case "applyFloors":
      return floorPayloadsToState(action.floors, state);

    // Replaces labels, artwork bounds and anchors wholesale. applyFloors cannot
    // do this: it merges transforms into the floors already in state by label,
    // so a new label set (e.g. 1F/2F/3F over the initial "artwork") is dropped.
    case "resetPlacement":
      return action.state;

    default:
      return state;
  }
}

/**
 * Undo history around {@link placementReducer}.
 *
 * A drag emits an action per animation frame, so those are coalesced: while a
 * gesture stays open, the newest state replaces the present instead of pushing
 * a new entry, and the gizmo closes the gesture on release. Ctrl+Z therefore
 * undoes a whole drag, not one frame of it.
 */
export type PlacementHistory = {
  present: PlacementState;
  past: PlacementState[];
  future: PlacementState[];
  /** Action type of the drag currently collapsing into one entry. */
  openGesture: string | null;
};

/** Actions a drag repeats; consecutive ones share a single undo entry. */
const CONTINUOUS_ACTIONS: Record<string, true> = {
  dragFloor: true,
  rotateFrame: true,
  scaleFrame: true,
  rotateFloor: true,
  scaleFloor: true
};

/** Key the coalescing by floor too: 1F then 2F are two steps, not one. */
function gestureKey(action: PlacementAction): string | null {
  if (!CONTINUOUS_ACTIONS[action.type]) return null;
  return "label" in action ? `${action.type}:${action.label}` : action.type;
}

/** Selection, not a change to the placement: never an undo step. */
const NON_HISTORIC_ACTIONS: Record<string, true> = { setActiveFloor: true };

const HISTORY_LIMIT = 50;

export function initialPlacementHistory(present: PlacementState): PlacementHistory {
  return { present, past: [], future: [], openGesture: null };
}

export function placementHistoryReducer(
  history: PlacementHistory,
  action: PlacementAction
): PlacementHistory {
  switch (action.type) {
    case "undo": {
      const previous = history.past[history.past.length - 1];
      if (!previous) return history;
      return {
        present: previous,
        past: history.past.slice(0, -1),
        future: [history.present, ...history.future],
        openGesture: null
      };
    }
    case "redo": {
      const next = history.future[0];
      if (!next) return history;
      return {
        present: next,
        past: [...history.past, history.present],
        future: history.future.slice(1),
        openGesture: null
      };
    }
    case "endGesture":
      return history.openGesture ? { ...history, openGesture: null } : history;
    case "resetPlacement":
      // A new drawing or assignment; undoing into the previous one is nonsense.
      return initialPlacementHistory(action.state);
    case "positionBuilding":
      // The auto-located starting position is where undo should bottom out, not
      // a step that can be undone back to an arbitrary default.
      if (action.baseline) {
        return initialPlacementHistory(placementReducer(history.present, action));
      }
      break;
    default:
      break;
  }

  const present = placementReducer(history.present, action);
  // Rejected actions (locked scale, unknown floor) must not consume history.
  if (present === history.present) return history;
  if (NON_HISTORIC_ACTIONS[action.type]) return { ...history, present };
  const key = gestureKey(action);
  if (key && history.openGesture === key) {
    return { ...history, present };
  }
  return {
    present,
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    future: [],
    openGesture: key
  };
}

/** Residuals of the active floor's control points, or null below the minimum. */
export function currentResiduals(
  state: PlacementState
): { perPoint: number[]; rmse: number } | null {
  const active = activeFloor(state);
  if (!active || active.controlPoints.length < 2) return null;
  const [lon0, lat0] = active.mapAnchor;
  const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
  return residuals(
    resolvedTransform(state, active),
    active.controlPoints.map((p) => p.artwork),
    enu
  );
}

export function useIllustratorPlacement(initial: PlacementState) {
  const [state, dispatch] = useReducer(placementReducer, initial);
  return { state, dispatch };
}
