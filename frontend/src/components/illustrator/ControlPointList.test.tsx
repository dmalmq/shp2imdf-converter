import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { ControlPointList } from "./ControlPointList";
import {
  DEFAULT_METRES_PER_POINT,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";


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

function renderList(pickStage: "artwork" | "map" | null, dispatch: (a: PlacementAction) => void = () => {}) {
  render(
    <ControlPointList
      state={STATE}
      dispatch={dispatch}
      pickStage={pickStage}
      mode="individual"
      onTogglePicking={() => {}}
    />
  );
}


test("idle state offers to add a point", () => {
  renderList(null);
  expect(screen.getByRole("button", { name: /add point/i })).toBeInTheDocument();
});

test("the artwork stage prompts for a click on the plan", () => {
  renderList("artwork");
  expect(screen.getByRole("button", { name: /point on the plan/i })).toBeInTheDocument();
});

test("the map stage prompts for the corresponding map click", () => {
  renderList("map");
  expect(screen.getByRole("button", { name: /same point on the map/i })).toBeInTheDocument();
});

test("the fit action carries the current adjustment mode", () => {
  const withPoints: PlacementState = {
    ...STATE,
    floors: STATE.floors.map((f) =>
      f.label === "1F"
        ? {
            ...f,
            controlPoints: [
              { id: "a", artwork: [0, 0], map: [139.7, 35.69] },
              { id: "b", artwork: [100, 0], map: [139.701, 35.69] }
            ]
          }
        : f
    )
  };
  const seen: PlacementAction[] = [];
  render(
    <ControlPointList
      state={withPoints}
      dispatch={(action) => seen.push(action)}
      pickStage={null}
      mode="group"
      onTogglePicking={() => {}}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /fit to control points/i }));
  expect(seen).toEqual([{ type: "fitControlPoints", mode: "group" }]);
});
