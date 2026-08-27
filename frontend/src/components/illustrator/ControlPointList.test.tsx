import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  DEFAULT_METRES_PER_POINT,
  type AdjustmentMode,
  type ControlPoint,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { enuToLngLat } from "../../lib/similarity";
import { ControlPointList } from "./ControlPointList";

const ANCHOR: [number, number] = [139.7671, 35.6812];
const ARTWORK_ANCHOR: [number, number] = [50, 50];

function controlPoints(count: number): ControlPoint[] {
  const scale = DEFAULT_METRES_PER_POINT;
  const artworkPoints: [number, number][] = [
    [0, 0],
    [100, 0],
    [0, 100]
  ];
  return artworkPoints.slice(0, count).map((artwork, index) => {
    const east = (artwork[0] - ARTWORK_ANCHOR[0]) * scale + (index === 2 ? 10 : 0);
    const north = (artwork[1] - ARTWORK_ANCHOR[1]) * scale;
    return {
      id: String(index + 1),
      artwork,
      map: enuToLngLat(east, north, ANCHOR[0], ANCHOR[1])
    };
  });
}

function placementState(count = 0, activeLinked = true): PlacementState {
  return {
    frame: {
      rotationDeg: 0,
      metresPerPoint: DEFAULT_METRES_PER_POINT,
      workingCrs: "EPSG:6677"
    },
    activeFloorLabel: "1F",
    scaleLocked: false,
    floors: ["1F", "2F"].map((label) => ({
      label,
      linked: label === "1F" ? activeLinked : true,
      artworkAnchor: ARTWORK_ANCHOR,
      mapAnchor: ANCHOR,
      controlPoints: label === "1F" ? controlPoints(count) : [],
      artworkBounds: [0, 0, 100, 100] as [number, number, number, number],
      ...(label === "1F" || activeLinked
        ? {}
        : { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT })
    }))
  };
}

function renderList({
  count = 0,
  mode = "individual",
  activeLinked = true,
  pickStage = null,
  dispatch = () => {}
}: {
  count?: number;
  mode?: AdjustmentMode;
  activeLinked?: boolean;
  pickStage?: "artwork" | "map" | null;
  dispatch?: (action: PlacementAction) => void;
} = {}) {
  render(
    <ControlPointList
      state={placementState(count, activeLinked)}
      dispatch={dispatch}
      pickStage={pickStage}
      mode={mode}
      onTogglePicking={() => {}}
    />
  );
}

test.each([
  [0, "0 / 3 minimum", "Start with a distinctive corner."],
  [1, "1 / 3 minimum", "Choose the second point far from #1."],
  [2, "2 / 3 minimum", "Choose the third point away from the line between #1 and #2."],
  [3, "3 / 3 minimum", "Ready to fit. Add more pairs if the reference is noisy."]
])("shows count-specific guidance at %i pairs", (count, progress, guidance) => {
  renderList({ count });
  expect(screen.getByText(progress)).toBeInTheDocument();
  expect(screen.getByText(guidance)).toBeInTheDocument();
});

test("retains the two picking prompts and names the idle action Add matching pair", () => {
  const { rerender } = render(
    <ControlPointList
      state={placementState()}
      dispatch={() => {}}
      pickStage={null}
      mode="individual"
      onTogglePicking={() => {}}
    />
  );
  expect(screen.getByRole("button", { name: "Add matching pair" })).toBeInTheDocument();

  rerender(
    <ControlPointList
      state={placementState()}
      dispatch={() => {}}
      pickStage="artwork"
      mode="individual"
      onTogglePicking={() => {}}
    />
  );
  expect(screen.getByRole("button", { name: "Click a point on the plan..." })).toBeInTheDocument();

  rerender(
    <ControlPointList
      state={placementState()}
      dispatch={() => {}}
      pickStage="map"
      mode="individual"
      onTogglePicking={() => {}}
    />
  );
  expect(
    screen.getByRole("button", { name: "Click the same point on the map..." })
  ).toBeInTheDocument();
});

test("disables fitting below three points", () => {
  renderList({ count: 2 });
  expect(screen.getByRole("button", { name: "Fit this floor" })).toBeDisabled();
});

test.each([
  ["group", "Fit all linked floors"],
  ["individual", "Fit this floor"]
] as const)("enables the %s fit at three points and dispatches its scope", (mode, label) => {
  const seen: PlacementAction[] = [];
  renderList({ count: 3, mode, dispatch: (action) => seen.push(action) });
  const button = screen.getByRole("button", { name: label });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(seen).toEqual([{ type: "fitControlPoints", mode }]);
});

test("explains that a group fit moves every linked floor", () => {
  renderList({ mode: "group" });
  expect(
    screen.getByText(
      "Align from 1F. Add at least 3 matching points spread around the plan. The fit moves every linked floor together."
    )
  ).toBeInTheDocument();
});

test("labels the current RMSE and the largest pair mismatch", () => {
  renderList({ count: 3 });
  expect(screen.getByText(/Current RMSE:/)).toBeInTheDocument();
  expect(screen.getByText(/#3 .*Largest mismatch/)).toBeInTheDocument();
  expect(screen.getByText(/#1 /)).not.toHaveTextContent("Largest mismatch");
  expect(screen.getByText(/#2 /)).not.toHaveTextContent("Largest mismatch");
});

test("shows the map overlay legend", () => {
  renderList();
  expect(screen.getByText("Artwork position")).toBeInTheDocument();
  expect(screen.getByText("Reference target")).toBeInTheDocument();
  expect(screen.getByText("Residual")).toBeInTheDocument();
});

test("blocks group registration from an unlinked active floor", () => {
  renderList({ count: 3, mode: "group", activeLinked: false });
  expect(screen.getByRole("button", { name: "Add matching pair" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Fit all linked floors" })).toBeDisabled();
  expect(screen.getByText("Relink 1F before fitting all floors.")).toBeInTheDocument();
});
