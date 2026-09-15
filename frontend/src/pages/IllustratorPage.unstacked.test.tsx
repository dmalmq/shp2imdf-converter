import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureCollection, Polygon } from "geojson";

import { assignFloors, previewIllustrator, snapIllustratorSurvey } from "../api/client";
import type * as ApiClient from "../api/client";
import type { ShapeMatchPanelModel } from "../components/illustrator/ShapeMatchPanel";
import type { PlacementTab } from "../components/illustrator/PlacementSidebar";
import {
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
} from "../hooks/useIllustratorPlacement";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  assignFloors: vi.fn(),
  previewIllustrator: vi.fn(),
  snapIllustratorSurvey: vi.fn()
}));

function squares(count: number, lon: number): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, i) => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lon + i / 1000, 35.613],
            [lon + i / 1000 + 0.0003, 35.613],
            [lon + i / 1000 + 0.0003, 35.6133],
            [lon + i / 1000, 35.613]
          ]
        ]
      }
    }))
  };
}

const STATION_PG = {
  name: "Station_pg",
  data: squares(5, 140.113),
  color: "#0f766e",
  visible: true,
  featureCount: 5,
  truncated: false
};

const ALIGNED: ApiClient.IllustratorPageAlignment = {
  page: 2,
  anchor_page: 1,
  offset: [0, 0],
  rotation_deg: 0,
  scale: 1,
  overlap_iou: 1,
  matched_outlines: 5,
  aligned: true,
  reason: null
};

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  tab: PlacementTab;
  shapeMatch: ShapeMatchPanelModel;
  onReferenceLayersChange: (layers: (typeof STATION_PG)[]) => void;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({
    state,
    dispatch,
    mode,
    tab,
    shapeMatch,
    onReferenceLayersChange
  }: SidebarProps) => (
    <section>
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: "positionBuilding",
            mapAnchor: [140.1134, 35.6132],
            workingCrs: "EPSG:6677",
            baseline: true
          })
        }
      >
        Pin station
      </button>
      <button type="button" onClick={() => onReferenceLayersChange([STATION_PG])}>
        Add Station_pg
      </button>
      <button type="button" onClick={shapeMatch.onStartArtworkMatch}>
        Match 4F to 3F
      </button>
      <output data-testid="mode">{mode}</output>
      <output data-testid="tab">{tab}</output>
      <output data-testid="match-target">
        {shapeMatch.referenceFloorLabel || shapeMatch.referenceName || "none"}
      </output>
      <output data-testid="artwork-match-target">{shapeMatch.artworkMatchTarget || "none"}</output>
      <output data-testid="linked-floors">
        {state.floors.map((floor) => String(floor.linked)).join(",")}
      </output>
      {state.floors.map((floor) => (
        <output key={floor.label} data-testid={`floor-anchor-${floor.label}`}>
          {floor.mapAnchor[0]},{floor.mapAnchor[1]}
        </output>
      ))}
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  ARTWORK_TINT: "#ea580c",
  PlacementMap: ({
    state,
    dispatch,
    shapePickActive
  }: {
    state: PlacementState;
    dispatch: Dispatch<PlacementAction>;
    shapePickActive?: boolean;
  }) => (
    <section>
      <output data-testid="shape-pick">{shapePickActive ? "picking" : "idle"}</output>
      <button type="button" onClick={() => dispatch({ type: "setActiveFloor", label: "4F" })}>
        Select 4F
      </button>
    </section>
  )
}));

const preview = vi.mocked(previewIllustrator);
const assign = vi.mocked(assignFloors);
const snap = vi.mocked(snapIllustratorSurvey);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "unstacked-test",
  report: {
    source_name: "0989_千葉.ai",
    page_count: 4,
    pages: [1, 2, 3, 4].map((index) => ({ index, width_pt: 200, height_pt: 160 })),
    total_features: 4,
    layers: {},
    warnings: [],
    page_alignment: [
      { ...ALIGNED, page: 2 },
      { ...ALIGNED, page: 3 },
      {
        ...ALIGNED,
        page: 4,
        aligned: false,
        overlap_iou: 0,
        matched_outlines: 0,
        reason: "no_consensus"
      }
    ]
  },
  layers: [],
  pages: [1, 2, 3, 4].map((index) => ({
    index,
    bounds: index === 4 ? [0, 0, 400, 320] : [0, 0, 200, 160],
    width_pt: index === 4 ? 400 : 200,
    height_pt: index === 4 ? 320 : 160,
    feature_count: 1,
    preview_feature_count: 1
  })),
  artwork_bounds: [0, 0, 400, 320],
  preview: { type: "FeatureCollection", features: [] },
  preview_features: 0,
  total_features: 4,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "JGD2011 / Japan Plane Rectangular CS IX"
};

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  snap.mockReset();
  preview.mockResolvedValue(PREVIEW);
  assign.mockResolvedValue({
    floors: ["1F", "2F", "3F", "4F"].map((label) => ({
      label,
      feature_count: 1,
      artwork_bounds: label === "4F" ? [0, 0, 400, 320] : [0, 0, 200, 160],
      layer_counts: []
    })),
    unassigned_count: 0,
    total_features: 4
  });
  snap.mockResolvedValue({
    match: {
      rank: 1,
      score: 0.9,
      relative_gap: null,
      reference_feature_index: 0,
      reference_part_index: 0,
      transform: {
        artwork_anchor: [100, 80],
        map_anchor: [140.11315, 35.61348],
        rotation_deg: -36.4,
        metres_per_point: 0.3528,
        working_crs: "EPSG:6677"
      },
      boundary_rmse_m: 1.3,
      boundary_p95_m: 2.6,
      max_residual_m: 3.9,
      overlap_iou: 0.92,
      reference_geometry: STATION_PG.data.features[0].geometry,
      residual_vectors: []
    },
    reason: null
  });
});

async function enterPlacementView() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "0989_千葉.ai")] }
  });
  await screen.findByTestId("page-alignment-warning");
  fireEvent.click(screen.getByRole("button", { name: "Done assigning" }));
  await screen.findByRole("button", { name: "Pin station" });
}

test("an unstacked 4F stays unlinked, follows the pin, and matches onto 3F", async () => {
  await enterPlacementView();
  expect(screen.getByTestId("linked-floors")).toHaveTextContent("true,true,true,false");

  fireEvent.click(screen.getByRole("button", { name: "Pin station" }));
  expect(screen.getByTestId("floor-anchor-4F")).toHaveTextContent("140.1134,35.6132");
  expect(screen.getByTestId("floor-anchor-1F")).toHaveTextContent("140.1134,35.6132");

  fireEvent.click(screen.getByRole("button", { name: "Add Station_pg" }));
  expect(screen.getByTestId("match-target")).toHaveTextContent("Station_pg");
  expect(screen.getByTestId("artwork-match-target")).toHaveTextContent("none");

  fireEvent.click(screen.getByRole("button", { name: "Select 4F" }));
  await waitFor(() => expect(screen.getByTestId("match-target")).toHaveTextContent("3F"));
  expect(screen.getByTestId("artwork-match-target")).toHaveTextContent("3F");

  fireEvent.click(screen.getByRole("button", { name: "Match 4F to 3F" }));
  expect(screen.getByTestId("mode")).toHaveTextContent("individual");
  expect(screen.getByTestId("tab")).toHaveTextContent("fit");
  expect(screen.getByTestId("shape-pick")).toHaveTextContent("picking");
  expect(screen.getByTestId("match-target")).toHaveTextContent("3F");
});
