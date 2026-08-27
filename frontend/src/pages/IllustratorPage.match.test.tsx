import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Feature, Polygon } from "geojson";

import { assignFloors, matchIllustratorShape, previewIllustrator } from "../api/client";
import type * as ApiClient from "../api/client";
import type { ShapeMatchPanelModel } from "../components/illustrator/ShapeMatchPanel";
import type {
  AdjustmentMode,
  PlacementAction,
  PlacementState
} from "../hooks/useIllustratorPlacement";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  assignFloors: vi.fn(),
  matchIllustratorShape: vi.fn(),
  previewIllustrator: vi.fn()
}));

const selectedFeature: Feature<Polygon> = {
  type: "Feature",
  properties: {
    page: 1,
    ai_layer: "Fill Layer",
    role: "polygon",
    source_table: "Fill_Layer",
    source_row: 0
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [200, 0], [200, 160], [0, 160], [0, 0]]]
  }
};

const referenceLayer = {
  name: "building-footprints",
  data: {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [[139.7668, 35.6809], [139.7674, 35.6809], [139.7674, 35.6813], [139.7668, 35.6809]]
          ]
        }
      }
    ]
  },
  color: "#0f766e",
  visible: true,
  featureCount: 1,
  truncated: false
};

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  shapeMatch: ShapeMatchPanelModel;
  onReferenceLayersChange: (layers: typeof referenceLayer[]) => void;
};

type MapProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  onModeChange: (mode: AdjustmentMode) => void;
  shapePickActive?: boolean;
  shapeMatchPreview?: { suggestion: ApiClient.IllustratorShapeMatchSuggestion } | null;
  onPickShape?: (selection: {
    floorLabel: string;
    sourceTable: string;
    sourceRow: number;
    feature: Feature<Polygon>;
  }) => void;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, shapeMatch, onReferenceLayersChange }: SidebarProps) => (
    <section>
      <button type="button" onClick={() => onReferenceLayersChange([referenceLayer])}>
        Add reference
      </button>
      <button type="button" onClick={shapeMatch.onToggleSelection}>
        Choose outline
      </button>
      <button type="button" onClick={() => shapeMatch.onMatchTargetChange("floor:2F")}>
        Match 2F
      </button>
      <button
        type="button"
        disabled={
          !shapeMatch.selection || !(shapeMatch.referenceName || shapeMatch.referenceFloorLabel)
        }
        onClick={shapeMatch.onFind}
      >
        Find matches
      </button>
      <button type="button" disabled={!shapeMatch.previewRank} onClick={shapeMatch.onApply}>
        Apply suggestion
      </button>
      <output data-testid="match-count">{shapeMatch.matches.length}</output>
      <output data-testid="match-selection">{shapeMatch.selection ? "selected" : "empty"}</output>
      <output data-testid="match-target">
        {shapeMatch.referenceFloorLabel || shapeMatch.referenceName || "none"}
      </output>
      <output data-testid="frame-rotation">{state.frame.rotationDeg}</output>
      <output data-testid="active-rotation">
        {String(
          state.floors.find((floor) => floor.label === state.activeFloorLabel)?.rotationDeg ??
            state.frame.rotationDeg
        )}
      </output>
      <output data-testid="linked-floors">
        {state.floors.map((floor) => String(floor.linked)).join(",")}
      </output>
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
    shapePickActive,
    shapeMatchPreview,
    onPickShape
  }: MapProps) => {
    const activeIndex = state.floors.findIndex((floor) => floor.label === state.activeFloorLabel);
    const nextFloor = state.floors[(activeIndex + 1) % state.floors.length];
    return (
      <section>
        <output data-testid="shape-pick">{shapePickActive ? "picking" : "idle"}</output>
        <output data-testid="preview-rank">{shapeMatchPreview?.suggestion.rank ?? "none"}</output>
        <button
          type="button"
          disabled={!shapePickActive}
          onClick={() =>
            onPickShape?.({
              floorLabel: state.activeFloorLabel,
              sourceTable: "Fill_Layer",
              sourceRow: 0,
              feature: selectedFeature
            })
          }
        >
          Pick shape
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
const matchShapes = vi.mocked(matchIllustratorShape);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "shape-match-test",
  report: {
    source_name: "shape-match.ai",
    page_count: 3,
    pages: [
      { index: 1, width_pt: 200, height_pt: 160 },
      { index: 2, width_pt: 200, height_pt: 160 },
      { index: 3, width_pt: 200, height_pt: 160 }
    ],
    total_features: 3,
    layers: {},
    warnings: []
  },
  layers: [],
  pages: [1, 2, 3].map((index) => ({
    index,
    bounds: [0, 0, 200, 160],
    width_pt: 200,
    height_pt: 160,
    feature_count: 1,
    preview_feature_count: 1
  })),
  artwork_bounds: [0, 0, 200, 160],
  preview: { type: "FeatureCollection", features: [selectedFeature] },
  preview_features: 1,
  total_features: 3,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "JGD2011 / Japan Plane Rectangular CS IX"
};

const MATCHES: ApiClient.IllustratorShapeMatchSuggestion[] = [1, 2, 3].map((rank) => ({
  rank,
  score: rank * 0.1,
  relative_gap: rank < 3 ? 0.2 : null,
  reference_feature_index: rank - 1,
  reference_part_index: 0,
  transform: {
    artwork_anchor: [100, 80],
    map_anchor: [139.767 + rank * 0.0001, 35.6812],
    rotation_deg: 25,
    metres_per_point: 0.5,
    working_crs: "EPSG:6677"
  },
  boundary_rmse_m: rank,
  boundary_p95_m: rank * 2,
  max_residual_m: rank * 3,
  overlap_iou: 0.9 - rank * 0.1,
  reference_geometry: referenceLayer.data.features[0].geometry,
  residual_vectors: []
}));

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  matchShapes.mockReset();
  preview.mockResolvedValue(PREVIEW);
  assign.mockResolvedValue({
    floors: ["1F", "2F", "3F"].map((label) => ({
      label,
      feature_count: 1,
      artwork_bounds: [0, 0, 200, 160],
      layer_counts: []
    })),
    unassigned_count: 0,
    total_features: 3
  });
  matchShapes.mockResolvedValue({ matches: MATCHES });
});

async function enterPlacementView() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "shape-match.ai")] }
  });
  fireEvent.click(await screen.findByRole("button", { name: "Done assigning" }));
  await screen.findByRole("button", { name: "Add reference" });
}

async function selectOutline() {
  fireEvent.click(screen.getByRole("button", { name: "Add reference" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose outline" }));
  expect(screen.getByTestId("shape-pick")).toHaveTextContent("picking");
  fireEvent.click(screen.getByRole("button", { name: "Pick shape" }));
  expect(screen.getByTestId("match-selection")).toHaveTextContent("selected");
}

test("ranks and previews shapes without moving floors until explicit apply", async () => {
  await enterPlacementView();
  await selectOutline();

  fireEvent.click(screen.getByRole("button", { name: "Find matches" }));
  await waitFor(() => expect(screen.getByTestId("match-count")).toHaveTextContent("3"));
  expect(screen.getByTestId("preview-rank")).toHaveTextContent("1");
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");
  expect(matchShapes).toHaveBeenCalledWith(
    "shape-match-test",
    expect.objectContaining({
      floor_label: "1F",
      artwork: { source_table: "Fill_Layer", source_row: 0 },
      scale_locked: false,
      reference: referenceLayer.data
    })
  );

  fireEvent.click(screen.getByRole("button", { name: "Apply suggestion" }));
  await waitFor(() => expect(screen.getByTestId("frame-rotation")).toHaveTextContent("25"));
  expect(screen.getByTestId("linked-floors")).toHaveTextContent("true,true,true");
});

test("matching another floor posts that floor and unlinks only the active floor", async () => {
  await enterPlacementView();
  fireEvent.click(screen.getByRole("button", { name: "Match 2F" }));
  expect(screen.getByTestId("match-target")).toHaveTextContent("2F");
  fireEvent.click(screen.getByRole("button", { name: "Choose outline" }));
  fireEvent.click(screen.getByRole("button", { name: "Pick shape" }));

  fireEvent.click(screen.getByRole("button", { name: "Find matches" }));
  await waitFor(() => expect(screen.getByTestId("match-count")).toHaveTextContent("3"));
  expect(matchShapes).toHaveBeenCalledWith(
    "shape-match-test",
    expect.objectContaining({
      floor_label: "1F",
      artwork: { source_table: "Fill_Layer", source_row: 0 },
      reference_floor: expect.objectContaining({ label: "2F" })
    })
  );
  const payload = matchShapes.mock.calls[matchShapes.mock.calls.length - 1]?.[1] as ApiClient.IllustratorShapeMatchRequest;
  expect(payload.reference).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Apply suggestion" }));
  await waitFor(() => expect(screen.getByTestId("linked-floors")).toHaveTextContent("false,true,true"));
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");
  expect(screen.getByTestId("active-rotation")).toHaveTextContent("25");
});

test("changing floor or mode discards an uncommitted shape selection", async () => {
  await enterPlacementView();
  await selectOutline();
  fireEvent.click(screen.getByRole("button", { name: "Change floor" }));
  await waitFor(() => expect(screen.getByTestId("match-selection")).toHaveTextContent("empty"));
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");

  await selectOutline();
  fireEvent.click(screen.getByRole("button", { name: "Change mode" }));
  expect(screen.getByTestId("match-selection")).toHaveTextContent("empty");
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");
});
