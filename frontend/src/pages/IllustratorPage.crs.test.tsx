import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { assignFloors, previewIllustrator } from "../api/client";
import type * as ApiClient from "../api/client";
import {
  type AdjustmentMode,
  type PlacementAction,
  type PlacementState
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
  outputCrs: string;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, dispatch, outputCrs }: SidebarProps) => (
    <section>
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: "positionBuilding",
            mapAnchor: [140.7288, 41.7687],
            workingCrs: "EPSG:6679",
            baseline: true
          })
        }
      >
        Pin Hakodate
      </button>
      <output data-testid="working-crs">{state.frame.workingCrs}</output>
      <output data-testid="output-crs">{outputCrs}</output>
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  FLOOR_TINTS: ["#111111"],
  PlacementMap: () => <section data-testid="map" />
}));

const preview = vi.mocked(previewIllustrator);
const assign = vi.mocked(assignFloors);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "crs-test",
  report: {
    source_name: "hakodate.ai",
    page_count: 1,
    pages: [{ index: 1, width_pt: 200, height_pt: 160 }],
    total_features: 1,
    layers: {},
    warnings: []
  },
  layers: [],
  pages: [
    {
      index: 1,
      bounds: [0, 0, 200, 160],
      width_pt: 200,
      height_pt: 160,
      feature_count: 1,
      preview_feature_count: 1
    }
  ],
  artwork_bounds: [0, 0, 200, 160],
  preview: { type: "FeatureCollection", features: [] },
  preview_features: 0,
  total_features: 1,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "EPSG:6677 — JPR CS IX"
};

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  preview.mockResolvedValue(PREVIEW);
  assign.mockResolvedValue({
    floors: [{ label: "1F", feature_count: 1, artwork_bounds: [0, 0, 200, 160], layer_counts: [] }],
    unassigned_count: 0,
    total_features: 1
  });
});

test("export CRS follows the locate pin, not the Tokyo preview seed", async () => {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "hakodate.ai")] }
  });
  fireEvent.click(await screen.findByRole("button", { name: /Skip/ }));
  await screen.findByRole("button", { name: "Pin Hakodate" });
  expect(screen.getByTestId("working-crs")).toHaveTextContent("EPSG:6677");
  expect(screen.getByTestId("output-crs")).toHaveTextContent("EPSG:6677");

  fireEvent.click(screen.getByRole("button", { name: "Pin Hakodate" }));
  await waitFor(() => expect(screen.getByTestId("working-crs")).toHaveTextContent("EPSG:6679"));
  expect(screen.getByTestId("output-crs")).toHaveTextContent("EPSG:6679");
});
