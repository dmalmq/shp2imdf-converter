import { useReducer } from "react";

import type { TransformPayload } from "../api/client";
import {
  applyMatrix,
  artworkToLngLat,
  enuToLngLat,
  fitHelmert,
  lngLatToEnu,
  metresPerPointForScale,
  residuals,
  toEnuMatrix,
  transformGeoJson,
  type SimilarityTransform
} from "../lib/similarity";

/** Our Illustrator floor plans are authored at 1:1000. */
export const DEFAULT_DRAWING_SCALE = 1000;

/** Ground metres per PDF point at {@link DEFAULT_DRAWING_SCALE}. */
export const DEFAULT_METRES_PER_POINT = metresPerPointForScale(DEFAULT_DRAWING_SCALE);

/** Product-level minimum for accepting a similarity fit. */
export const MIN_CONTROL_POINTS = 3;

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

/**
 * Which floors placement gestures act on: the whole linked group, or the
 * active floor alone. UI-level only — never part of the undoable state, the
 * export payload, or a saved placement.
 */
export type AdjustmentMode = "group" | "individual";

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
  | { type: "fitControlPoints"; mode: AdjustmentMode }
  | { type: "applySimilarity"; mode: AdjustmentMode; transform: SimilarityTransform }
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
          f.label === action.label
            ? f.linked
              ? // Detach with the frame values frozen in, so later frame
                // operations cannot drag an independently-placed floor along.
                { ...f, linked: false, rotationDeg, metresPerPoint: state.frame.metresPerPoint }
              : { ...f, rotationDeg }
            : f
        )
      };
    }

    case "scaleFloor": {
      if (!(action.metresPerPoint > 0)) return state;
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === action.label
            ? f.linked
              ? { ...f, linked: false, rotationDeg: state.frame.rotationDeg, metresPerPoint: action.metresPerPoint }
              : { ...f, metresPerPoint: action.metresPerPoint }
            : f
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
      if (
        !active ||
        active.controlPoints.length < MIN_CONTROL_POINTS ||
        (action.mode === "group" && !active.linked)
      ) {
        return state;
      }
      const [lon0, lat0] = active.mapAnchor;
      const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
      const frameFit = action.mode === "group";
      const fitted = fitHelmert(
        active.controlPoints.map((p) => p.artwork),
        enu,
        state.frame.workingCrs,
        frameFit && state.scaleLocked ? state.frame.metresPerPoint : undefined
      );
      if (frameFit) {
        // The frame takes the fitted rotation and scale; the active floor's
        // anchor is set to where ITS artwork anchor lands under the fit (not
        // the fitted centroid anchor), then every linked floor follows by
        // derivation. Nothing unlinks.
        // toEnuMatrix yields ENU relative to the fitted anchor; add it back
        // to land in the absolute ENU frame about (lon0, lat0).
        const rel = applyMatrix(
          toEnuMatrix(fitted),
          active.artworkAnchor[0],
          active.artworkAnchor[1]
        );
        const [lon, lat] = enuToLngLat(
          fitted.mapAnchor[0] + rel[0],
          fitted.mapAnchor[1] + rel[1],
          lon0,
          lat0
        );
        return recomputeLinked({
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
        });
      }
      // Individual fit: the fit owns this floor's full transform, including
      // its own anchor; keeping the region-centroid anchor would make
      // residuals wrong. The floor unlinks so the frame never fights the fit.
      const [lon, lat] = enuToLngLat(fitted.mapAnchor[0], fitted.mapAnchor[1], lon0, lat0);
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

    case "applySimilarity": {
      const active = activeFloor(state);
      if (!active || (action.mode === "group" && !active.linked)) {
        return state;
      }
      const transform = action.transform;
      if (action.mode === "group") {
        // Same apply path as a group fitControlPoints: the incoming transform
        // is already a resolved WGS84 similarity (not an ENU Helmert result).
        // Map the active floor's own artwork origin through it, then let every
        // linked floor follow the updated frame. Control points are untouched.
        const applied: SimilarityTransform = {
          ...transform,
          metresPerPoint: state.scaleLocked ? state.frame.metresPerPoint : transform.metresPerPoint
        };
        if (!(applied.metresPerPoint > 0)) return state;
        const [lon, lat] = artworkToLngLat(
          applied,
          active.artworkAnchor[0],
          active.artworkAnchor[1]
        );
        return recomputeLinked({
          ...state,
          frame: {
            ...state.frame,
            rotationDeg: applied.rotationDeg,
            metresPerPoint: applied.metresPerPoint
          },
          floors: state.floors.map((f) =>
            f.label === active.label ? { ...f, mapAnchor: [lon, lat] } : f
          )
        });
      }
      if (!(transform.metresPerPoint > 0)) return state;
      return {
        ...state,
        floors: state.floors.map((f) =>
          f.label === active.label
            ? {
                ...f,
                linked: false,
                artworkAnchor: [transform.artworkAnchor[0], transform.artworkAnchor[1]],
                mapAnchor: [transform.mapAnchor[0], transform.mapAnchor[1]],
                rotationDeg: transform.rotationDeg,
                metresPerPoint: transform.metresPerPoint
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
  if (!active || active.controlPoints.length < MIN_CONTROL_POINTS) return null;
  const [lon0, lat0] = active.mapAnchor;
  const enu = active.controlPoints.map((p) => lngLatToEnu(p.map[0], p.map[1], lon0, lat0));
  return residuals(
    resolvedTransform(state, active),
    active.controlPoints.map((p) => p.artwork),
    enu
  );
}

/**
 * Union of every floor's placed artwork bounds as a WGS84 lon/lat box: the
 * area of interest for reference-layer trimming.
 *
 * All four artwork corners go through {@link transformGeoJson}, never a
 * two-corner shortcut: rotation means the axis-aligned artwork box becomes a
 * rotated footprint on the ground, and two corners can leave the other two
 * outside the union. The artwork -> lon/lat maths stays in the similarity
 * module exactly once, pinned by the cross-language golden fixture.
 */
export function placedBoundsWgs84(
  state: PlacementState,
  floors: { label: string; bounds: [number, number, number, number] }[]
): [number, number, number, number] | null {
  let union: [number, number, number, number] | null = null;
  for (const floor of floors) {
    const placement = state.floors.find((f) => f.label === floor.label);
    if (!placement) continue;
    const [minX, minY, maxX, maxY] = floor.bounds;
    const corners = {
      type: "FeatureCollection" as const,
      features: [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY]
      ].map(([x, y]) => ({
        type: "Feature" as const,
        properties: null,
        geometry: { type: "Point" as const, coordinates: [x, y] }
      }))
    };
    const placed = transformGeoJson(corners, resolvedTransform(state, placement));
    for (const feature of placed.features) {
      // transformGeoJson moves Point coordinates in place, so every feature
      // here stays the Point we constructed above.
      const geometry = feature.geometry;
      if (geometry?.type !== "Point") continue;
      const [lon, lat] = geometry.coordinates;
      union = union
        ? [
            Math.min(union[0], lon),
            Math.min(union[1], lat),
            Math.max(union[2], lon),
            Math.max(union[3], lat)
          ]
        : [lon, lat, lon, lat];
    }
  }
  return union;
}

export function useIllustratorPlacement(initial: PlacementState) {
  const [state, dispatch] = useReducer(placementReducer, initial);
  return { state, dispatch };
}
