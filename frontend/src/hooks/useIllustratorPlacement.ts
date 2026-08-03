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

export type ControlPoint = {
  id: string;
  artwork: [number, number];
  /** WGS84 lon/lat. Converted to ENU only for the duration of a fit. */
  map: [number, number];
};

export type PlacementState = {
  transform: SimilarityTransform;
  scaleLocked: boolean;
  controlPoints: ControlPoint[];
};

export type PlacementAction =
  | { type: "moveAnchor"; mapAnchor: [number, number] }
  | { type: "rotate"; rotationDeg: number }
  | { type: "scale"; metresPerPoint: number }
  | { type: "setDrawingScale"; denominator: number }
  | { type: "calibrateDistance"; artworkDistance: number; realMetres: number }
  | { type: "unlockScale" }
  | { type: "setWorkingCrs"; workingCrs: string }
  | { type: "addControlPoint"; point: ControlPoint }
  | { type: "removeControlPoint"; id: string }
  | { type: "fitControlPoints" }
  | { type: "applyTransform"; transform: SimilarityTransform };

function normaliseRotation(degrees: number): number {
  const wrapped = ((degrees + 180) % 360) - 180;
  return wrapped <= -180 ? wrapped + 360 : wrapped;
}

/** Control points as ENU metres about the current anchor. */
function toEnuPairs(state: PlacementState): [number, number][] {
  const [lon0, lat0] = state.transform.mapAnchor;
  return state.controlPoints.map((point) => lngLatToEnu(point.map[0], point.map[1], lon0, lat0));
}

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case "moveAnchor":
      return { ...state, transform: { ...state.transform, mapAnchor: action.mapAnchor } };

    case "rotate":
      return {
        ...state,
        transform: { ...state.transform, rotationDeg: normaliseRotation(action.rotationDeg) }
      };

    case "scale":
      // A locked scale came from the drawing itself; dragging must not destroy it.
      if (state.scaleLocked || !(action.metresPerPoint > 0)) return state;
      return { ...state, transform: { ...state.transform, metresPerPoint: action.metresPerPoint } };

    case "setDrawingScale":
      if (!(action.denominator > 0)) return state;
      return {
        ...state,
        scaleLocked: true,
        transform: {
          ...state.transform,
          metresPerPoint: metresPerPointForScale(action.denominator)
        }
      };

    case "calibrateDistance":
      if (!(action.artworkDistance > 0) || !(action.realMetres > 0)) return state;
      return {
        ...state,
        scaleLocked: true,
        transform: {
          ...state.transform,
          metresPerPoint: action.realMetres / action.artworkDistance
        }
      };

    case "unlockScale":
      return { ...state, scaleLocked: false };

    case "setWorkingCrs":
      return { ...state, transform: { ...state.transform, workingCrs: action.workingCrs } };

    case "addControlPoint":
      return { ...state, controlPoints: [...state.controlPoints, action.point] };

    case "removeControlPoint":
      return {
        ...state,
        controlPoints: state.controlPoints.filter((point) => point.id !== action.id)
      };

    case "fitControlPoints": {
      if (state.controlPoints.length < 2) return state;
      const [lon0, lat0] = state.transform.mapAnchor;
      const fitted = fitHelmert(
        state.controlPoints.map((point) => point.artwork),
        toEnuPairs(state),
        state.transform.workingCrs,
        state.scaleLocked ? state.transform.metresPerPoint : undefined
      );
      // fitHelmert returns the anchor in ENU metres; store lon/lat.
      const [lon, lat] = enuToLngLat(fitted.mapAnchor[0], fitted.mapAnchor[1], lon0, lat0);
      return { ...state, transform: { ...fitted, mapAnchor: [lon, lat] } };
    }

    case "applyTransform":
      return { ...state, transform: action.transform, scaleLocked: true };

    default:
      return state;
  }
}

/** Residuals of the current control points, or null below the fit minimum. */
export function currentResiduals(
  state: PlacementState
): { perPoint: number[]; rmse: number } | null {
  if (state.controlPoints.length < 2) return null;
  return residuals(
    state.transform,
    state.controlPoints.map((point) => point.artwork),
    toEnuPairs(state)
  );
}

export function toTransformPayload(transform: SimilarityTransform): TransformPayload {
  return {
    artwork_anchor: transform.artworkAnchor,
    map_anchor: transform.mapAnchor,
    rotation_deg: transform.rotationDeg,
    metres_per_point: transform.metresPerPoint,
    working_crs: transform.workingCrs
  };
}

export function fromTransformPayload(payload: TransformPayload): SimilarityTransform {
  return {
    artworkAnchor: payload.artwork_anchor,
    mapAnchor: payload.map_anchor,
    rotationDeg: payload.rotation_deg,
    metresPerPoint: payload.metres_per_point,
    workingCrs: payload.working_crs
  };
}

export function useIllustratorPlacement(initial: PlacementState) {
  const [state, dispatch] = useReducer(placementReducer, initial);
  return { state, dispatch };
}
