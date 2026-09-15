import React from "react";
import { render, screen } from "@testing-library/react";

import {
  DEFAULT_METRES_PER_POINT,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { ScaleAndFitPanel } from "./ScaleAndFitPanel";
import type { ShapeMatchPanelModel } from "./ShapeMatchPanel";

function placementState(unstacked: string[] = []): PlacementState {
  const labels = ["1F", "2F"];
  return {
    frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
    activeFloorLabel: labels[0],
    scaleLocked: false,
    floors: labels.map((label) => ({
      label,
      linked: true,
      artworkAnchor: [50, 40] as [number, number],
      mapAnchor: [139.7671, 35.6812] as [number, number],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 80] as [number, number, number, number],
      ...(unstacked.includes(label) ? { artworkMatch: true } : {})
    }))
  };
}

const shapeMatch: ShapeMatchPanelModel = {
  referenceName: "",
  referenceFloorLabel: "",
  selecting: false,
  selection: null,
  matches: [],
  previewRank: null,
  loading: false,
  searched: false,
  error: null,
  sourceFloorLabel: "1F",
  regionStage: null,
  hasSourceRegion: false,
  hasTargetRegion: false,
  onToggleRegions: vi.fn(),
  onReferenceChange: vi.fn(),
  onMatchTargetChange: vi.fn(),
  onToggleSelection: vi.fn(),
  onFind: vi.fn(),
  onPreview: vi.fn(),
  onApply: vi.fn(),
  onClear: vi.fn(),
  onCancel: vi.fn()
};

function renderPanel(state: PlacementState) {
  return render(
    <ScaleAndFitPanel
      state={state}
      dispatch={vi.fn()}
      pickStage={null}
      mode="group"
      onTogglePicking={vi.fn()}
      referenceLayers={[]}
      shapeMatch={shapeMatch}
    />
  );
}

test("control points is the default, because most placements start from a reference", () => {
  renderPanel(placementState());
  expect(screen.getByRole("tab", { name: "Control points" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("a floor that did not stack opens shape match, where its one-click fix lives", () => {
  renderPanel(placementState(["2F"]));
  expect(screen.getByRole("tab", { name: "Shape match" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("the unstacked floor need not be the active one to choose the tab", () => {
  const state = placementState(["2F"]);
  expect(state.activeFloorLabel).toBe("1F");
  renderPanel(state);
  expect(screen.getByRole("tab", { name: "Shape match" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});
