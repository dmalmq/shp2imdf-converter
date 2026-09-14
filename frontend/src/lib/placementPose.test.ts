import { placementPoseReady } from "./placementPose";

test("artwork stays off the map until a pin exists", () => {
  expect(placementPoseReady(false, false, "idle")).toBe(false);
  expect(placementPoseReady(false, true, "ready")).toBe(false);
});

test("a pin without Station_pg is already a pose", () => {
  expect(placementPoseReady(true, false, "idle")).toBe(true);
});

test("Station_pg keeps artwork hidden until the snap settles", () => {
  expect(placementPoseReady(true, true, "idle")).toBe(false);
  expect(placementPoseReady(true, true, "pending")).toBe(false);
  expect(placementPoseReady(true, true, "ready")).toBe(true);
});
