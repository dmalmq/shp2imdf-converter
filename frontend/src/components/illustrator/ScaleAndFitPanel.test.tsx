import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { ScaleAndFitPanel } from "./ScaleAndFitPanel";
import {
  DEFAULT_METRES_PER_POINT,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import type { ShapeMatchPanelModel } from "./ShapeMatchPanel";

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
  activeFloorLabel: "2F",
  scaleLocked: false,
  floors: ["1F", "2F", "3F"].map((label) => ({
    label,
    linked: label === "1F",
    pinned: false,
    artworkAnchor: [50, 50] as [number, number],
    mapAnchor: [139.7671, 35.6812] as [number, number],
    controlPoints: [],
    artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
  }))
};

const noop = () => {};

const SHAPE_MATCH: ShapeMatchPanelModel = {
  referenceName: "",
  referenceFloorLabel: "",
  selecting: false,
  selection: null,
  matches: [],
  previewRank: null,
  loading: false,
  searched: false,
  error: null,
  onReferenceChange: noop,
  onMatchTargetChange: noop,
  onToggleSelection: noop,
  sourceFloorLabel: "",
  regionStage: null,
  hasSourceRegion: false,
  hasTargetRegion: false,
  onToggleRegions: noop,
  onFind: noop,
  onPreview: noop,
  onInspect: noop,
  onApply: noop,
  onClear: noop,
  onCancel: noop
};

function renderPanel(dispatch: (action: PlacementAction) => void) {
  render(
    <ScaleAndFitPanel
      state={STATE}
      dispatch={dispatch}
      pickStage={null}
      mode="individual"
      onTogglePicking={() => {}}
      referenceLayers={[]}
      shapeMatch={SHAPE_MATCH}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
}

test("advanced scale and calibration carry the adjustment mode and name the scope", () => {
  const seen: PlacementAction[] = [];
  renderPanel((action) => seen.push(action));
  expect(screen.getByTestId("placement-scope")).toHaveTextContent("Editing 2F only");

  fireEvent.change(screen.getByLabelText("Drawing scale denominator"), {
    target: { value: "500" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.change(screen.getByLabelText("Distance on the artwork"), { target: { value: "400" } });
  fireEvent.change(screen.getByLabelText("Real-world metres"), { target: { value: "70" } });
  fireEvent.click(screen.getByRole("button", { name: "Calibrate" }));

  expect(seen).toEqual([
    { type: "setDrawingScale", denominator: 500, mode: "individual" },
    { type: "calibrateDistance", artworkDistance: 400, realMetres: 70, mode: "individual" }
  ]);
});
