import { fireEvent, renderHook } from "@testing-library/react";

import { usePlacementShortcuts } from "./usePlacementShortcuts";
import {
  DEFAULT_METRES_PER_POINT,
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "./useIllustratorPlacement";


const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
  activeFloorLabel: "1F",
  scaleLocked: false,
  floors: ["1F", "2F"].map((label) => ({
    label,
    linked: true,
    artworkAnchor: [50, 50] as [number, number],
    mapAnchor: [139.7671, 35.6812] as [number, number],
    controlPoints: [],
    artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
  }))
};

function nudge(mode: AdjustmentMode, key: string): PlacementAction[] {
  const seen: PlacementAction[] = [];
  renderHook(() =>
    usePlacementShortcuts({ state: STATE, dispatch: (action) => seen.push(action), mode, enabled: true })
  );
  fireEvent.keyDown(window, { key });
  return seen;
}


test("arrow keys nudge the whole group in group mode", () => {
  const seen = nudge("group", "ArrowRight");
  expect(seen).toEqual([{ type: "positionBuilding", mapAnchor: expect.any(Array) }]);
});

test("arrow keys nudge only the active floor in individual mode", () => {
  const seen = nudge("individual", "ArrowRight");
  expect(seen).toEqual([{ type: "dragFloor", label: "1F", mapAnchor: expect.any(Array) }]);
});
