import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { assignFloors, previewIllustrator } from "../api/client";
import type * as ApiClient from "../api/client";
import type {
  AdjustmentMode,
  PlacementAction,
  PlacementState
} from "../hooks/useIllustratorPlacement";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  assignFloors: vi.fn(),
  previewIllustrator: vi.fn()
}));

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  pickStage: "artwork" | "map" | null;
  onTogglePicking: () => void;
};

type MapProps = SidebarProps & {
  onModeChange: (mode: AdjustmentMode) => void;
  pendingArtwork: [number, number] | null;
  onPickArtwork: (point: [number, number]) => void;
  onPickMap: (point: [number, number]) => void;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, dispatch, mode, pickStage, onTogglePicking }: SidebarProps) => (
    <section>
      <button type="button" onClick={onTogglePicking}>
        Add matching pair
      </button>
      <button type="button" onClick={() => dispatch({ type: "fitControlPoints", mode })}>
        Fit control points
      </button>
      <output data-testid="sidebar-stage">{pickStage ?? "closed"}</output>
      <output data-testid="active-floor">{state.activeFloorLabel}</output>
      <output data-testid="point-counts">
        {state.floors.map((floor) => `${floor.label}:${floor.controlPoints.length}`).join(",")}
      </output>
      <output data-testid="frame-rotation">{state.frame.rotationDeg}</output>
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  FLOOR_TINTS: ["#111111", "#222222", "#333333"],
  PlacementMap: ({
    state,
    dispatch,
    mode,
    onModeChange,
    pickStage,
    pendingArtwork,
    onPickArtwork,
    onPickMap
  }: MapProps) => {
    const active = state.floors.find((floor) => floor.label === state.activeFloorLabel)!;
    const pointIndex = active.controlPoints.length;
    const artworkPoints: [number, number][] = [
      [0, 0],
      [100, 0],
      [0, 100]
    ];
    const mapPoints: [number, number][] = [
      [139.7, 35.69],
      [139.7, 35.6905],
      [139.6995, 35.69]
    ];
    const activeIndex = state.floors.findIndex((floor) => floor.label === active.label);
    const nextFloor = state.floors[(activeIndex + 1) % state.floors.length];

    return (
      <section>
        <output data-testid="map-stage">{pickStage ?? "closed"}</output>
        <output data-testid="pending-artwork">{pendingArtwork ? "pending" : "empty"}</output>
        <button
          type="button"
          disabled={pickStage !== "artwork"}
          onClick={() => onPickArtwork(artworkPoints[pointIndex])}
        >
          Pick artwork
        </button>
        <button
          type="button"
          disabled={pickStage !== "map"}
          onClick={() => onPickMap(mapPoints[pointIndex])}
        >
          Pick map
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "setActiveFloor", label: nextFloor.label })}
        >
          Change floor
        </button>
        <button
          type="button"
          onClick={() => onModeChange(mode === "group" ? "individual" : "group")}
        >
          Change mode
        </button>
      </section>
    );
  }
}));

const preview = vi.mocked(previewIllustrator);
const assign = vi.mocked(assignFloors);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "alignment-test",
  report: {
    source_name: "alignment-three.ai",
    page_count: 3,
    pages: [
      { index: 1, width_pt: 200, height_pt: 200 },
      { index: 2, width_pt: 200, height_pt: 200 },
      { index: 3, width_pt: 200, height_pt: 200 }
    ],
    total_features: 3,
    layers: {},
    warnings: []
  },
  layers: [],
  pages: [1, 2, 3].map((index) => ({
    index,
    bounds: [0, 0, 200, 200],
    width_pt: 200,
    height_pt: 200,
    feature_count: 1,
    preview_feature_count: 1
  })),
  artwork_bounds: [0, 0, 200, 200],
  preview: { type: "FeatureCollection", features: [] },
  preview_features: 3,
  total_features: 3,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "JGD2011 / Japan Plane Rectangular CS IX"
};

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  preview.mockResolvedValue(PREVIEW);
  assign.mockResolvedValue({
    floors: ["1F", "2F", "3F"].map((label) => ({
      label,
      feature_count: 1,
      artwork_bounds: [0, 0, 200, 200],
      layer_counts: []
    })),
    unassigned_count: 0,
    total_features: 3
  });
});

async function enterPlacementView() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "alignment-three.ai")] }
  });
  fireEvent.click(await screen.findByRole("button", { name: "Done assigning" }));
  await screen.findByRole("button", { name: "Add matching pair" });
}

function completePair() {
  fireEvent.click(screen.getByRole("button", { name: "Pick artwork" }));
  expect(screen.getByTestId("map-stage")).toHaveTextContent("map");
  expect(screen.getByTestId("pending-artwork")).toHaveTextContent("pending");
  fireEvent.click(screen.getByRole("button", { name: "Pick map" }));
}

test("collects three pairs before closing and fits only from the sidebar", async () => {
  await enterPlacementView();

  fireEvent.click(screen.getByRole("button", { name: "Add matching pair" }));
  expect(screen.getByTestId("map-stage")).toHaveTextContent("artwork");

  completePair();
  expect(screen.getByTestId("map-stage")).toHaveTextContent("artwork");
  completePair();
  expect(screen.getByTestId("map-stage")).toHaveTextContent("artwork");
  expect(screen.getByTestId("point-counts")).toHaveTextContent("1F:2,2F:0,3F:0");
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");

  completePair();
  expect(screen.getByTestId("map-stage")).toHaveTextContent("closed");
  expect(screen.getByTestId("point-counts")).toHaveTextContent("1F:3,2F:0,3F:0");
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");

  fireEvent.click(screen.getByRole("button", { name: "Fit control points" }));
  await waitFor(() => expect(Number(screen.getByTestId("frame-rotation").textContent)).not.toBe(0));
});

test("changing floor or mode discards a pending artwork half-pair", async () => {
  await enterPlacementView();

  fireEvent.click(screen.getByRole("button", { name: "Add matching pair" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick artwork" }));
  fireEvent.click(screen.getByRole("button", { name: "Change floor" }));
  await waitFor(() => expect(screen.getByTestId("map-stage")).toHaveTextContent("closed"));
  expect(screen.getByTestId("point-counts")).toHaveTextContent("1F:0,2F:0,3F:0");

  fireEvent.click(screen.getByRole("button", { name: "Add matching pair" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick artwork" }));
  fireEvent.click(screen.getByRole("button", { name: "Change mode" }));
  expect(screen.getByTestId("map-stage")).toHaveTextContent("closed");
  expect(screen.getByTestId("point-counts")).toHaveTextContent("1F:0,2F:0,3F:0");
});
