import {
  currentResiduals,
  floorPayloadsToState,
  placementReducer,
  resolvedTransform,
  toFloorPayloads,
  type FloorPlacement,
  type PlacementState
} from "./useIllustratorPlacement";
import { enuToLngLat, lngLatToEnu } from "../lib/similarity";

const ANCHOR: [number, number] = [139.700258, 35.690921];

function floor(label: string, anchor: [number, number], linked = true): FloorPlacement {
  return {
    label,
    linked,
    artworkAnchor: label === "1F" ? [85, 80] : [285, 80],
    mapAnchor: anchor,
    controlPoints: [],
    artworkBounds: label === "1F" ? [0, 0, 170, 160] : [200, 0, 370, 160]
  };
}

const BASE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [floor("1F", ANCHOR), floor("2F", ANCHOR)],
  activeFloorLabel: "1F",
  scaleLocked: false
};

test("positioning the active floor moves every linked floor by derivation", () => {
  const target: [number, number] = [139.71, 35.7];
  const next = placementReducer(BASE, { type: "positionBuilding", mapAnchor: target });
  expect(next.floors[0].mapAnchor).toEqual(target);
  // 1F -> 2F artwork offset is (200, 0) pt; at s=0.176389 that is 35.2778 m east.
  const [e, n] = lngLatToEnu(
    next.floors[1].mapAnchor[0],
    next.floors[1].mapAnchor[1],
    target[0],
    target[1]
  );
  expect(e).toBeCloseTo(200 * 0.176389, 6);
  expect(n).toBeCloseTo(0, 6);
});

test("rotateFrame rotates linked offsets about the active anchor", () => {
  const next = placementReducer(BASE, { type: "rotateFrame", rotationDeg: 90 });
  expect(next.frame.rotationDeg).toBe(90);
  const [e, n] = lngLatToEnu(
    next.floors[1].mapAnchor[0],
    next.floors[1].mapAnchor[1],
    ANCHOR[0],
    ANCHOR[1]
  );
  // (200,0) pt rotated 90deg CCW -> (0,200) pt -> 35.2778 m north.
  expect(e).toBeCloseTo(0, 6);
  expect(n).toBeCloseTo(200 * 0.176389, 6);
});

test("dragging a floor unlinks it and leaves others alone", () => {
  const dragged: [number, number] = [139.72, 35.71];
  const next = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: dragged });
  expect(next.floors[1].linked).toBe(false);
  expect(next.floors[1].mapAnchor).toEqual(dragged);
  expect(next.floors[0].mapAnchor).toEqual(ANCHOR);
  expect(next.floors[0].linked).toBe(true);
});

test("frame operations ignore unlinked floors", () => {
  const dragged: [number, number] = [139.72, 35.71];
  let state = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: dragged });
  state = placementReducer(state, { type: "rotateFrame", rotationDeg: 45 });
  // The pinned floor keeps its absolute position through the rotation.
  expect(state.floors[1].mapAnchor).toEqual(dragged);
  expect(state.floors[1].linked).toBe(false);
  // The linked floor follows the rotation about the active anchor.
  const [e, n] = lngLatToEnu(
    state.floors[0].mapAnchor[0],
    state.floors[0].mapAnchor[1],
    ANCHOR[0],
    ANCHOR[1]
  );
  expect(e).toBeCloseTo(0, 6);
  expect(n).toBeCloseTo(0, 6);
});

test("relinkFloor restores derivation from the frame", () => {
  let state = placementReducer(BASE, {
    type: "dragFloor",
    label: "2F",
    mapAnchor: [139.72, 35.71]
  });
  state = placementReducer(state, { type: "relinkFloor", label: "2F" });
  expect(state.floors[1].linked).toBe(true);
  const [e, n] = lngLatToEnu(
    state.floors[1].mapAnchor[0],
    state.floors[1].mapAnchor[1],
    ANCHOR[0],
    ANCHOR[1]
  );
  expect(e).toBeCloseTo(200 * 0.176389, 6);
});

test("unlockFloor freezes the frame values into the floor", () => {
  const state = placementReducer(BASE, { type: "unlockFloor", label: "2F" });
  const f = state.floors[1];
  expect(f.linked).toBe(false);
  expect(f.rotationDeg).toBe(0);
  expect(f.metresPerPoint).toBeCloseTo(0.176389, 9);
});

test("single-floor dragging keeps the floor linked", () => {
  const single: PlacementState = { ...BASE, floors: [floor("1F", ANCHOR)] };
  const next = placementReducer(single, {
    type: "dragFloor",
    label: "1F",
    mapAnchor: [139.72, 35.71]
  });
  expect(next.floors[0].linked).toBe(true);
});

test("a locked scale rejects scaleFrame", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  state = placementReducer(state, { type: "scaleFrame", metresPerPoint: 9 });
  expect(state.frame.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("rotateFrame without any linked floor no-ops", () => {
  let state = placementReducer(BASE, { type: "unlockFloor", label: "1F" });
  state = placementReducer(state, { type: "unlockFloor", label: "2F" });
  const next = placementReducer(state, { type: "rotateFrame", rotationDeg: 33 });
  expect(next.frame.rotationDeg).toBe(0);
});

test("resolvedTransform uses the frame for linked floors", () => {
  const resolved = resolvedTransform(BASE, BASE.floors[1]);
  expect(resolved.rotationDeg).toBe(0);
  expect(resolved.metresPerPoint).toBeCloseTo(0.176389, 9);
  expect(resolved.workingCrs).toBe("EPSG:6677");
});

test("resolvedTransform uses the floor's own values once unlinked", () => {
  const state = placementReducer(BASE, { type: "unlockFloor", label: "2F" });
  const f = state.floors[1];
  const resolved = resolvedTransform(state, f);
  expect(resolved.rotationDeg).toBe(0);
  expect(resolved.artworkAnchor).toEqual(f.artworkAnchor);
});

test("toFloorPayloads emits one payload per floor", () => {
  const payloads = toFloorPayloads(BASE);
  expect(payloads.map((p) => p.label)).toEqual(["1F", "2F"]);
  expect(payloads[0].transform.working_crs).toBe("EPSG:6677");
});

test("floorPayloadsToState rebuilds linked floors and the frame", () => {
  const saved = [
    {
      label: "1F",
      transform: {
        artwork_anchor: [85, 80],
        map_anchor: [139.701, 35.701],
        rotation_deg: 10,
        metres_per_point: 0.176389,
        working_crs: "EPSG:6677"
      }
    },
    {
      label: "2F",
      transform: {
        artwork_anchor: [285, 80],
        map_anchor: [139.7015, 35.7018],
        rotation_deg: 10,
        metres_per_point: 0.176389,
        working_crs: "EPSG:6677"
      }
    }
  ];
  const state = floorPayloadsToState(saved, BASE);
  expect(state.floors.every((f) => f.linked)).toBe(true);
  expect(state.frame.rotationDeg).toBe(10);
  expect(state.frame.metresPerPoint).toBeCloseTo(0.176389, 9);
  expect(state.floors[0].mapAnchor).toEqual([139.701, 35.701]);
  expect(state.floors[0].artworkAnchor).toEqual([85, 80]);
});

test("control points act on the active floor", () => {
  let state = placementReducer(BASE, { type: "setActiveFloor", label: "2F" });
  state = placementReducer(state, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(state.floors[1].controlPoints).toHaveLength(1);
  expect(state.floors[0].controlPoints).toHaveLength(0);
  state = placementReducer(state, { type: "removeControlPoint", id: "a" });
  expect(state.floors[1].controlPoints).toHaveLength(0);
});

test("rotation is normalised into (-180, 180]", () => {
  expect(placementReducer(BASE, { type: "rotateFrame", rotationDeg: 200 }).frame.rotationDeg).toBe(
    -160
  );
  expect(placementReducer(BASE, { type: "rotateFrame", rotationDeg: -540 }).frame.rotationDeg).toBe(
    180
  );
});

test("setting a drawing scale locks the scale", () => {
  const next = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  expect(next.frame.metresPerPoint).toBeCloseTo(0.1763888888, 9);
  expect(next.scaleLocked).toBe(true);
});

test("unlocking the scale lets scaleFrame work again", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  state = placementReducer(state, { type: "unlockScale" });
  state = placementReducer(state, { type: "scaleFrame", metresPerPoint: 0.5 });
  expect(state.frame.metresPerPoint).toBe(0.5);
});

test("distance calibration locks the scale", () => {
  const next = placementReducer(BASE, {
    type: "calibrateDistance",
    artworkDistance: 400,
    realMetres: 70.5556
  });
  expect(next.frame.metresPerPoint).toBeCloseTo(0.1763889, 6);
  expect(next.scaleLocked).toBe(true);
});

test("fitting control points drives residuals to zero", () => {
  let state = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  state = placementReducer(state, {
    type: "addControlPoint",
    point: { id: "b", artwork: [500, 0], map: [139.701, 35.6903] }
  });
  state = placementReducer(state, { type: "fitControlPoints" });
  const fit = currentResiduals(state);
  expect(fit).not.toBeNull();
  expect(fit!.rmse).toBeLessThan(0.01);
});
