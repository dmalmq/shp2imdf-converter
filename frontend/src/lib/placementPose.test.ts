import { placementPoseReady, sameSurveySnap, surveySnapAwaitingRetrim } from "./placementPose";
import type { FeatureCollection } from "geojson";

const LAYER: FeatureCollection = { type: "FeatureCollection", features: [] };
const PIN: [number, number] = [140.1134, 35.6132];

test("artwork stays off the map until a pin exists", () => {
  expect(placementPoseReady(false, false, "idle")).toBe(false);
  expect(placementPoseReady(false, true, "ready")).toBe(false);
});

test("a failed lookup lets the operator place by hand", () => {
  expect(placementPoseReady(false, false, "idle", { locateSettled: true })).toBe(true);
  expect(placementPoseReady(false, true, "ready", { locateSettled: true })).toBe(true);
});

test("a pin without Station_pg is already a pose", () => {
  expect(placementPoseReady(true, false, "idle")).toBe(true);
});

test("Station_pg keeps artwork hidden until the snap settles", () => {
  expect(placementPoseReady(true, true, "idle")).toBe(false);
  expect(placementPoseReady(true, true, "pending")).toBe(false);
  expect(placementPoseReady(true, true, "ready")).toBe(true);
});

test("a ready pose still waits if the snap belongs to another pin or layer", () => {
  expect(
    placementPoseReady(true, true, "ready", { snapMatchesCurrent: false })
  ).toBe(false);
  expect(
    sameSurveySnap({ collection: LAYER, pin: PIN }, LAYER, PIN)
  ).toBe(true);
  expect(
    sameSurveySnap({ collection: LAYER, pin: PIN }, LAYER, [140.12, 35.62])
  ).toBe(false);
  expect(sameSurveySnap({ collection: LAYER, pin: PIN }, { ...LAYER }, PIN)).toBe(false);
  expect(surveySnapAwaitingRetrim({ collection: LAYER, pin: PIN }, LAYER, PIN)).toBe(false);
  expect(surveySnapAwaitingRetrim({ collection: LAYER, pin: PIN }, LAYER, [140.12, 35.62])).toBe(
    true
  );
});
