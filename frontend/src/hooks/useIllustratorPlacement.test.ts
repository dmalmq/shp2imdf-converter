import {
  DEFAULT_DRAWING_SCALE,
  DEFAULT_METRES_PER_POINT,
  currentResiduals,
  floorPayloadsToState,
  initialPlacementHistory,
  placedBoundsWgs84,
  placementHistoryReducer,
  placementReducer,
  resolvedTransform,
  toFloorPayloads,
  type FloorPlacement,
  type PlacementState
} from "./useIllustratorPlacement";
import { enuToLngLat, lngLatToEnu, type SimilarityTransform } from "../lib/similarity";

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

test("the default drawing scale is 1:1000", () => {
  // Our Illustrator floor plans are authored at 1:1000; a wrong default would
  // georeference every export at the wrong size.
  expect(DEFAULT_DRAWING_SCALE).toBe(1000);
  expect(DEFAULT_METRES_PER_POINT).toBeCloseTo(0.3527777778, 9);
});

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
  // Freezing the frame values means a later frame rotation cannot drag the
  // independently placed floor along.
  expect(next.floors[1].rotationDeg).toBe(0);
  expect(next.floors[1].metresPerPoint).toBeCloseTo(0.176389, 9);
});

test("a dragged floor keeps its own transform through later frame changes", () => {
  let state = placementReducer(BASE, {
    type: "dragFloor",
    label: "2F",
    mapAnchor: [139.72, 35.71]
  });
  state = placementReducer(state, { type: "rotateFrame", rotationDeg: 90 });
  const own = resolvedTransform(state, state.floors[1]);
  expect(own.rotationDeg).toBe(0); // not 90: the frame's rotation must not leak in
  expect(own.metresPerPoint).toBeCloseTo(0.176389, 9);
});

test("rotateFloor and scaleFloor only touch their own floor", () => {
  let state = placementReducer(BASE, { type: "dragFloor", label: "2F", mapAnchor: [139.72, 35.71] });
  state = placementReducer(state, { type: "rotateFloor", label: "2F", rotationDeg: 40 });
  state = placementReducer(state, { type: "scaleFloor", label: "2F", metresPerPoint: 0.5 });
  expect(state.floors[1].rotationDeg).toBe(40);
  expect(state.floors[1].metresPerPoint).toBe(0.5);
  // 1F stays on the frame.
  expect(state.floors[0].rotationDeg).toBeUndefined();
  expect(resolvedTransform(state, state.floors[0]).rotationDeg).toBe(0);
});

test("a non-positive per-floor scale is rejected", () => {
  const state = placementReducer(BASE, { type: "scaleFloor", label: "2F", metresPerPoint: -1 });
  expect(state).toBe(BASE);
});

test("rotateFloor on a linked floor freezes the frame scale in and unlinks it", () => {
  // Individual mode rotates one floor directly; detaching with the frame
  // values frozen keeps the other frame values from moving it later.
  const state = placementReducer(BASE, { type: "rotateFloor", label: "2F", rotationDeg: 40 });
  const f = state.floors[1];
  expect(f.linked).toBe(false);
  expect(f.rotationDeg).toBe(40);
  expect(f.metresPerPoint).toBeCloseTo(BASE.frame.metresPerPoint, 9);
  // The anchor is untouched: the floor rotates in place.
  expect(f.mapAnchor).toEqual(BASE.floors[1].mapAnchor);
  expect(resolvedTransform(state, f).rotationDeg).toBe(40);
});

test("scaleFloor on a linked floor freezes the frame rotation in and unlinks it", () => {
  const rotated = placementReducer(BASE, { type: "rotateFrame", rotationDeg: 30 });
  const state = placementReducer(rotated, { type: "scaleFloor", label: "2F", metresPerPoint: 0.5 });
  const f = state.floors[1];
  expect(f.linked).toBe(false);
  expect(f.metresPerPoint).toBe(0.5);
  expect(f.rotationDeg).toBe(30);
  // 1F stays on the frame.
  expect(state.floors[0].linked).toBe(true);
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

test("resetPlacement installs a whole new floor set, labels and bounds included", () => {
  // A fresh conversion starts with the single "artwork" floor; assigning floors
  // in the Illustrator flow replaces it with the real label set.
  const initial: PlacementState = {
    ...BASE,
    floors: [floor("artwork", ANCHOR)],
    activeFloorLabel: "artwork"
  };
  const assigned: PlacementState = {
    frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
    activeFloorLabel: "1F",
    scaleLocked: false,
    floors: [floor("1F", ANCHOR), floor("2F", ANCHOR)]
  };
  const next = placementReducer(initial, { type: "resetPlacement", state: assigned });
  expect(next.floors.map((f) => f.label)).toEqual(["1F", "2F"]);
  expect(next.activeFloorLabel).toBe("1F");
  expect(next.floors[0].artworkBounds).toEqual([0, 0, 170, 160]);
  // The map draws a floor only when its label resolves to a transform.
  for (const f of next.floors) {
    expect(resolvedTransform(next, f).metresPerPoint).toBeCloseTo(0.176389, 9);
  }
});

test("applyFloors only updates floors already present, never adds labels", () => {
  // Contract boundary: applyFloors is the saved-placement merge, keyed by label.
  // Using it to install a new label set silently drops every floor (and would
  // leave any added floor without artworkBounds), so the assignment step must
  // use resetPlacement instead.
  const initial: PlacementState = {
    ...BASE,
    floors: [floor("artwork", ANCHOR)],
    activeFloorLabel: "artwork"
  };
  const next = placementReducer(initial, { type: "applyFloors", floors: toFloorPayloads(BASE) });
  expect(next.floors.map((f) => f.label)).toEqual(["artwork"]);
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

function controlPointState(count: 2 | 3, thirdOffset: [number, number] = [-50, 0]): PlacementState {
  const north = enuToLngLat(0, 50, ANCHOR[0], ANCHOR[1]);
  const third = enuToLngLat(thirdOffset[0], thirdOffset[1], ANCHOR[0], ANCHOR[1]);
  const points = [
    { id: "a", artwork: [0, 0] as [number, number], map: ANCHOR },
    { id: "b", artwork: [100, 0] as [number, number], map: north },
    { id: "c", artwork: [0, 100] as [number, number], map: third }
  ];
  return points.slice(0, count).reduce(
    (state, point) => placementReducer(state, { type: "addControlPoint", point }),
    BASE
  );
}

test("two control points cannot fit either scope and have no residual summary", () => {
  const state = controlPointState(2);
  expect(currentResiduals(state)).toBeNull();
  expect(placementReducer(state, { type: "fitControlPoints", mode: "group" })).toBe(state);
  expect(placementReducer(state, { type: "fitControlPoints", mode: "individual" })).toBe(state);
});

test("a three-point group fit recovers the shared frame and keeps every floor linked", () => {
  const state = placementReducer(controlPointState(3), {
    type: "fitControlPoints",
    mode: "group"
  });
  expect(state.frame.rotationDeg).toBeCloseTo(90, 6);
  expect(state.frame.metresPerPoint).toBeCloseTo(0.5, 9);
  expect(state.floors.map((floorPlacement) => floorPlacement.linked)).toEqual([true, true]);
  expect(currentResiduals(state)!.rmse).toBeLessThan(0.01);
});

test("a perturbed third target leaves a visible residual after fitting", () => {
  const state = placementReducer(controlPointState(3, [-45, 0]), {
    type: "fitControlPoints",
    mode: "group"
  });
  expect(currentResiduals(state)!.rmse).toBeGreaterThan(0.1);
});

test("a group-mode fit respects the locked scale", () => {
  let state = placementReducer(controlPointState(3), {
    type: "setDrawingScale",
    denominator: 500
  });
  state = placementReducer(state, { type: "fitControlPoints", mode: "group" });
  expect(state.frame.metresPerPoint).toBeCloseTo(0.1763888888, 9);
  expect(state.frame.rotationDeg).toBeCloseTo(90, 6);
  expect(state.floors[0].linked).toBe(true);
});

test("a three-point individual fit changes and unlinks only the active floor", () => {
  const before = controlPointState(3);
  const state = placementReducer(before, { type: "fitControlPoints", mode: "individual" });
  const fitted = state.floors[0];
  expect(fitted.linked).toBe(false);
  expect(fitted.rotationDeg).toBeCloseTo(90, 6);
  expect(fitted.metresPerPoint).toBeCloseTo(0.5, 9);
  expect(state.floors[1]).toEqual(before.floors[1]);
});

test("group fitting is a no-op when the registration floor is unlinked", () => {
  const state = placementReducer(controlPointState(3), { type: "unlockFloor", label: "1F" });
  expect(placementReducer(state, { type: "fitControlPoints", mode: "group" })).toBe(state);
});

function sampleSimilarity(): SimilarityTransform {
  return {
    artworkAnchor: [85, 80],
    mapAnchor: [139.71, 35.7],
    rotationDeg: 90,
    metresPerPoint: 0.5,
    workingCrs: "EPSG:6677"
  };
}

function stateWithControlPoints(): PlacementState {
  let state = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: ANCHOR }
  });
  state = placementReducer(state, { type: "setActiveFloor", label: "2F" });
  state = placementReducer(state, {
    type: "addControlPoint",
    point: { id: "b", artwork: [1, 1], map: ANCHOR }
  });
  return placementReducer(state, { type: "setActiveFloor", label: "1F" });
}

test("a group applySimilarity updates the shared frame and recomputes every linked floor", () => {
  const before = stateWithControlPoints();
  const next = placementReducer(before, {
    type: "applySimilarity",
    mode: "group",
    transform: sampleSimilarity()
  });
  expect(next.floors.map((floorPlacement) => floorPlacement.linked)).toEqual([true, true]);
  expect(next.frame.rotationDeg).toBe(90);
  expect(next.frame.metresPerPoint).toBe(0.5);
  expect(next.floors[0].mapAnchor[0]).toBeCloseTo(139.71, 9);
  expect(next.floors[0].mapAnchor[1]).toBeCloseTo(35.7, 9);
  expect(next.floors[0].artworkAnchor).toEqual(before.floors[0].artworkAnchor);
  expect(next.floors[0].controlPoints).toEqual(before.floors[0].controlPoints);
  expect(next.floors[1].controlPoints).toEqual(before.floors[1].controlPoints);
  const [e, n] = lngLatToEnu(
    next.floors[1].mapAnchor[0],
    next.floors[1].mapAnchor[1],
    139.71,
    35.7
  );
  expect(e).toBeCloseTo(0, 6);
  expect(n).toBeCloseTo(100, 6);
});

test("an individual applySimilarity changes and unlinks only the active floor", () => {
  const before = stateWithControlPoints();
  const next = placementReducer(before, {
    type: "applySimilarity",
    mode: "individual",
    transform: sampleSimilarity()
  });
  const fitted = next.floors[0];
  expect(fitted.linked).toBe(false);
  expect(fitted.rotationDeg).toBe(90);
  expect(fitted.metresPerPoint).toBe(0.5);
  expect(fitted.mapAnchor).toEqual([139.71, 35.7]);
  expect(fitted.artworkAnchor).toEqual([85, 80]);
  expect(fitted.controlPoints).toEqual(before.floors[0].controlPoints);
  expect(next.floors[1]).toEqual(before.floors[1]);
  expect(next.frame).toEqual(before.frame);
});

test("group applySimilarity is a no-op when the registration floor is unlinked", () => {
  const state = placementReducer(BASE, { type: "unlockFloor", label: "1F" });
  expect(
    placementReducer(state, { type: "applySimilarity", mode: "group", transform: sampleSimilarity() })
  ).toBe(state);
});

test("a group applySimilarity respects the locked scale like fitControlPoints", () => {
  let state = placementReducer(stateWithControlPoints(), {
    type: "setDrawingScale",
    denominator: 500
  });
  const lockedScale = state.frame.metresPerPoint;
  state = placementReducer(state, {
    type: "applySimilarity",
    mode: "group",
    transform: sampleSimilarity()
  });
  expect(state.frame.metresPerPoint).toBeCloseTo(lockedScale, 9);
  expect(state.frame.rotationDeg).toBe(90);
  expect(state.floors.map((floorPlacement) => floorPlacement.linked)).toEqual([true, true]);
  const [e, n] = lngLatToEnu(
    state.floors[1].mapAnchor[0],
    state.floors[1].mapAnchor[1],
    state.floors[0].mapAnchor[0],
    state.floors[0].mapAnchor[1]
  );
  expect(e).toBeCloseTo(0, 6);
  expect(n).toBeCloseTo(200 * lockedScale, 6);
});

test("an individual applySimilarity ignores scale lock like fitControlPoints", () => {
  const locked = placementReducer(stateWithControlPoints(), {
    type: "setDrawingScale",
    denominator: 500
  });
  const next = placementReducer(locked, {
    type: "applySimilarity",
    mode: "individual",
    transform: sampleSimilarity()
  });
  expect(next.frame.metresPerPoint).toBeCloseTo(locked.frame.metresPerPoint, 9);
  expect(next.floors[0].metresPerPoint).toBe(0.5);
  expect(next.floors[0].linked).toBe(false);
  expect(next.floors[1]).toEqual(locked.floors[1]);
});

test("applySimilarity is one historic undo step", () => {
  const before = stateWithControlPoints();
  let history = initialPlacementHistory(before);
  history = placementHistoryReducer(history, {
    type: "applySimilarity",
    mode: "group",
    transform: sampleSimilarity()
  });
  expect(history.past).toHaveLength(1);
  expect(history.future).toHaveLength(0);
  expect(history.present.frame.rotationDeg).toBe(90);
  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present).toBe(before);
  expect(history.past).toHaveLength(0);
});

test("a whole drag collapses into one undo step", () => {
  // A drag dispatches one action per animation frame; undo must not step
  // through frames.
  let history = initialPlacementHistory(BASE);
  for (const lat of [35.7, 35.71, 35.72, 35.73]) {
    history = placementHistoryReducer(history, {
      type: "dragFloor",
      label: "1F",
      mapAnchor: [139.72, lat]
    });
  }
  expect(history.past).toHaveLength(1);
  expect(history.present.floors[0].mapAnchor).toEqual([139.72, 35.73]);

  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.floors[0].mapAnchor).toEqual(ANCHOR);
});

test("releasing the drag starts a new undo step for the next one", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, {
    type: "dragFloor",
    label: "1F",
    mapAnchor: [139.72, 35.7]
  });
  history = placementHistoryReducer(history, { type: "endGesture" });
  history = placementHistoryReducer(history, {
    type: "dragFloor",
    label: "1F",
    mapAnchor: [139.73, 35.71]
  });
  expect(history.past).toHaveLength(2);

  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.floors[0].mapAnchor).toEqual([139.72, 35.7]);
});

test("redo replays an undone step and new work clears the redo stack", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, { type: "rotateFrame", rotationDeg: 30 });
  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.frame.rotationDeg).toBe(0);

  history = placementHistoryReducer(history, { type: "redo" });
  expect(history.present.frame.rotationDeg).toBe(30);

  history = placementHistoryReducer(history, { type: "undo" });
  history = placementHistoryReducer(history, { type: "setDrawingScale", denominator: 500 });
  expect(history.future).toHaveLength(0);
});

test("undo and redo at the ends of the history are no-ops", () => {
  const history = initialPlacementHistory(BASE);
  expect(placementHistoryReducer(history, { type: "undo" })).toBe(history);
  expect(placementHistoryReducer(history, { type: "redo" })).toBe(history);
});

test("a rejected action does not consume an undo step", () => {
  // Locked scale rejects scaleFrame; undo must not become a no-op instead of
  // reverting the lock.
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, { type: "setDrawingScale", denominator: 500 });
  const locked = history;
  history = placementHistoryReducer(history, { type: "scaleFrame", metresPerPoint: 9 });
  expect(history).toBe(locked);
});

test("choosing a floor is not an undo step", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, { type: "setActiveFloor", label: "2F" });
  expect(history.past).toHaveLength(0);
  expect(history.present.activeFloorLabel).toBe("2F");
});

test("a new assignment clears the history", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, { type: "rotateFrame", rotationDeg: 30 });
  const fresh: PlacementState = { ...BASE, floors: [floor("1F", ANCHOR)] };
  history = placementHistoryReducer(history, { type: "resetPlacement", state: fresh });
  expect(history.past).toHaveLength(0);
  expect(history.future).toHaveLength(0);
  expect(placementHistoryReducer(history, { type: "undo" })).toBe(history);
});

test("separate gesture types are separate undo steps", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, { type: "rotateFrame", rotationDeg: 10 });
  history = placementHistoryReducer(history, { type: "scaleFrame", metresPerPoint: 0.4 });
  expect(history.past).toHaveLength(2);
  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.frame.metresPerPoint).toBeCloseTo(0.176389, 9);
  expect(history.present.frame.rotationDeg).toBe(10);
});

test("dragging different floors makes separate undo steps even without a release", () => {
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, {
    type: "dragFloor",
    label: "1F",
    mapAnchor: [139.72, 35.7]
  });
  history = placementHistoryReducer(history, {
    type: "dragFloor",
    label: "2F",
    mapAnchor: [139.72, 35.71]
  });
  expect(history.past).toHaveLength(2);
  history = placementHistoryReducer(history, { type: "undo" });
  // Step 2 undone: 2F is back, 1F's drag (step 1) is still present.
  expect(history.present.floors[1].mapAnchor).toEqual(ANCHOR);
  expect(history.present.floors[0].mapAnchor).toEqual([139.72, 35.7]);
  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.floors[0].mapAnchor).toEqual(ANCHOR);
});

test("the auto-located baseline is the floor of the history, not an undo step", () => {
  // Undo after the initial locate must not fling the plan back to a default
  // anchor the user never chose.
  let history = initialPlacementHistory(BASE);
  history = placementHistoryReducer(history, {
    type: "positionBuilding",
    mapAnchor: [139.734, 35.606],
    baseline: true
  });
  expect(history.past).toHaveLength(0);
  expect(history.present.floors[0].mapAnchor).toEqual([139.734, 35.606]);
  expect(placementHistoryReducer(history, { type: "undo" })).toBe(history);

  // A location the user picks afterwards is a normal, undoable edit.
  history = placementHistoryReducer(history, {
    type: "positionBuilding",
    mapAnchor: [139.7, 35.69]
  });
  expect(history.past).toHaveLength(1);
  history = placementHistoryReducer(history, { type: "undo" });
  expect(history.present.floors[0].mapAnchor).toEqual([139.734, 35.606]);
});

// The golden fixture: the same transform constants
// backend/tests/test_illustrator_georeference.py asserts against, so the box
// here is cross-language pinned rather than self-referential.
const GOLDEN_PLACEMENT: PlacementState = {
  frame: { rotationDeg: 30, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  activeFloorLabel: "1F",
  scaleLocked: false,
  floors: [
    {
      label: "1F",
      linked: true,
      artworkAnchor: [100, 200],
      mapAnchor: ANCHOR,
      controlPoints: [],
      artworkBounds: [100, 200, 400, 350]
    }
  ]
};

test("placedBoundsWgs84 places the artwork bounds on the golden constants", () => {
  const box = placedBoundsWgs84(GOLDEN_PLACEMENT, [
    { label: "1F", bounds: GOLDEN_PLACEMENT.floors[0].artworkBounds }
  ]);
  expect(box).not.toBeNull();
  // The union of the four golden corners; the backend asserts the same corners
  // in test_illustrator_georeference.py.
  const [minLon, minLat, maxLon, maxLat] = box as [number, number, number, number];
  expect(minLon).toBeCloseTo(139.700111829, 6);
  expect(minLat).toBeCloseTo(35.690921, 6);
  expect(maxLon).toBeCloseTo(139.70076435, 6);
  expect(maxLat).toBeCloseTo(35.691366023, 6);
});

test("a rotated floor's box covers all four rotated corners", () => {
  // Rotation turns the axis-aligned artwork box into a rotated footprint: at
  // 45deg the west edge belongs to the NW corner and the east edge to the SE
  // corner. A two-corner shortcut (say SW+NE) bounds east by [0, 112.25] m and
  // misses both, shrinking the trim window by about 12 m per side.
  const rotated: PlacementState = {
    frame: { rotationDeg: 45, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
    activeFloorLabel: "1F",
    scaleLocked: false,
    floors: [
      {
        label: "1F",
        linked: true,
        artworkAnchor: [100, 200],
        mapAnchor: ANCHOR,
        controlPoints: [],
        artworkBounds: [0, 0, 1000, 100]
      }
    ]
  };
  const box = placedBoundsWgs84(rotated, [{ label: "1F", bounds: [0, 0, 1000, 100] }]);
  expect(box).not.toBeNull();
  const [minLon, minLat, maxLon, maxLat] = box as [number, number, number, number];
  expect(minLon).toBeCloseTo(139.700258, 9);
  expect(minLat).toBeCloseTo(35.690583761, 9);
  expect(maxLon).toBeCloseTo(139.701773767, 9);
  expect(maxLat).toBeCloseTo(35.691820304, 9);
});

test("placedBoundsWgs84 unions floors that land in different places", () => {
  // 1F carries the rotated golden box; 2F is unlinked with its own rotation 0,
  // so it pokes west and south of 1F. The union needs both: minLon/minLat come
  // from 2F alone, maxLon/maxLat from 1F alone.
  const second: FloorPlacement = {
    ...floor("2F", ANCHOR),
    linked: false,
    rotationDeg: 0,
    metresPerPoint: 0.176389
  };
  const multi: PlacementState = {
    frame: { rotationDeg: 30, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
    activeFloorLabel: "1F",
    scaleLocked: false,
    floors: [GOLDEN_PLACEMENT.floors[0], second]
  };
  const box = placedBoundsWgs84(multi, [
    { label: "1F", bounds: [100, 200, 400, 350] },
    { label: "2F", bounds: [200, 0, 370, 160] }
  ]);
  expect(box).not.toBeNull();
  const [minLon, minLat, maxLon, maxLat] = box as [number, number, number, number];
  expect(minLon).toBeCloseTo(139.700092357, 9);
  expect(minLat).toBeCloseTo(35.690793819, 9);
  expect(maxLon).toBeCloseTo(139.700764299, 9);
  expect(maxLat).toBeCloseTo(35.69136598, 9);
});

test("placedBoundsWgs84 returns null when no floor has a usable transform", () => {
  expect(placedBoundsWgs84(BASE, [{ label: "nope", bounds: [0, 0, 10, 10] }])).toBeNull();
  expect(placedBoundsWgs84(BASE, [])).toBeNull();
});
