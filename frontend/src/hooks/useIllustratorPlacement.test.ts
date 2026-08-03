import {
  currentResiduals,
  fromTransformPayload,
  placementReducer,
  toTransformPayload,
  type PlacementState
} from "./useIllustratorPlacement";

const BASE: PlacementState = {
  transform: {
    artworkAnchor: [250, 275],
    mapAnchor: [139.700258, 35.690921],
    rotationDeg: 0,
    metresPerPoint: 0.176389,
    workingCrs: "EPSG:6677"
  },
  scaleLocked: false,
  controlPoints: []
};

test("moving the anchor changes only the anchor", () => {
  const next = placementReducer(BASE, { type: "moveAnchor", mapAnchor: [139.8, 35.7] });
  expect(next.transform.mapAnchor).toEqual([139.8, 35.7]);
  expect(next.transform.rotationDeg).toBe(BASE.transform.rotationDeg);
  expect(next.transform.metresPerPoint).toBe(BASE.transform.metresPerPoint);
  expect(next.transform.artworkAnchor).toEqual(BASE.transform.artworkAnchor);
});

test("rotating changes only the rotation", () => {
  const next = placementReducer(BASE, { type: "rotate", rotationDeg: 33 });
  expect(next.transform.rotationDeg).toBe(33);
  expect(next.transform.mapAnchor).toEqual(BASE.transform.mapAnchor);
  expect(next.transform.metresPerPoint).toBe(BASE.transform.metresPerPoint);
});

test("rotation is normalised into (-180, 180]", () => {
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: 200 }).transform.rotationDeg).toBe(
    -160
  );
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: -540 }).transform.rotationDeg).toBe(
    180
  );
  expect(placementReducer(BASE, { type: "rotate", rotationDeg: 360 }).transform.rotationDeg).toBe(0);
});

test("setting a drawing scale locks the scale", () => {
  const next = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  expect(next.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
  expect(next.scaleLocked).toBe(true);
});

test("an invalid drawing scale is ignored", () => {
  expect(placementReducer(BASE, { type: "setDrawingScale", denominator: 0 })).toBe(BASE);
});

test("distance calibration locks the scale", () => {
  const next = placementReducer(BASE, {
    type: "calibrateDistance",
    artworkDistance: 400,
    realMetres: 70.5556
  });
  expect(next.transform.metresPerPoint).toBeCloseTo(0.1763889, 6);
  expect(next.scaleLocked).toBe(true);
});

test("a locked scale ignores scale-handle drags", () => {
  const locked = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  const dragged = placementReducer(locked, { type: "scale", metresPerPoint: 9 });
  expect(dragged.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("unlocking lets the scale handle work again", () => {
  const locked = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  const unlocked = placementReducer(locked, { type: "unlockScale" });
  expect(placementReducer(unlocked, { type: "scale", metresPerPoint: 0.5 }).transform.metresPerPoint).toBe(
    0.5
  );
});

test("a non-positive scale is rejected", () => {
  expect(placementReducer(BASE, { type: "scale", metresPerPoint: 0 }).transform.metresPerPoint).toBe(
    BASE.transform.metresPerPoint
  );
});

test("the working CRS can be set once the location is known", () => {
  const next = placementReducer(BASE, { type: "setWorkingCrs", workingCrs: "EPSG:6674" });
  expect(next.transform.workingCrs).toBe("EPSG:6674");
  expect(next.transform.mapAnchor).toEqual(BASE.transform.mapAnchor);
});

test("control points are added and removed by id", () => {
  const added = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(added.controlPoints).toHaveLength(1);
  expect(placementReducer(added, { type: "removeControlPoint", id: "a" }).controlPoints).toHaveLength(
    0
  );
});

test("fitting with fewer than two control points leaves the transform alone", () => {
  const added = placementReducer(BASE, {
    type: "addControlPoint",
    point: { id: "a", artwork: [0, 0], map: [139.7, 35.69] }
  });
  expect(placementReducer(added, { type: "fitControlPoints" }).transform).toEqual(added.transform);
});

test("fitting two control points recovers a placement that hits them", () => {
  let state = BASE;
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7, 35.69] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.701, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  const fit = currentResiduals(fitted);
  expect(fit).not.toBeNull();
  expect(fit!.rmse).toBeLessThan(0.01);
});

test("fitting keeps a locked scale", () => {
  let state = placementReducer(BASE, { type: "setDrawingScale", denominator: 500 });
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7, 35.69] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.701, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  expect(fitted.transform.metresPerPoint).toBeCloseTo(0.1763888888, 9);
});

test("a fitted anchor is stored as lon/lat, not metres", () => {
  let state = BASE;
  for (const point of [
    { id: "a", artwork: [0, 0] as [number, number], map: [139.7, 35.69] as [number, number] },
    { id: "b", artwork: [500, 0] as [number, number], map: [139.701, 35.6903] as [number, number] }
  ]) {
    state = placementReducer(state, { type: "addControlPoint", point });
  }
  const fitted = placementReducer(state, { type: "fitControlPoints" });
  expect(fitted.transform.mapAnchor[0]).toBeGreaterThan(139);
  expect(fitted.transform.mapAnchor[0]).toBeLessThan(140);
  expect(fitted.transform.mapAnchor[1]).toBeGreaterThan(35);
  expect(fitted.transform.mapAnchor[1]).toBeLessThan(36);
});

test("applying a saved transform locks the scale", () => {
  const applied = placementReducer(BASE, {
    type: "applyTransform",
    transform: { ...BASE.transform, rotationDeg: 77 }
  });
  expect(applied.transform.rotationDeg).toBe(77);
  expect(applied.scaleLocked).toBe(true);
});

test("payload conversion round-trips", () => {
  const payload = toTransformPayload(BASE.transform);
  expect(payload.working_crs).toBe("EPSG:6677");
  expect(payload.map_anchor).toEqual([139.700258, 35.690921]);
  expect(fromTransformPayload(payload)).toEqual(BASE.transform);
});
