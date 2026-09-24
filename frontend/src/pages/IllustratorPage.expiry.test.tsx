import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { assignFloors, exportIllustrator, previewIllustrator } from "../api/client";
import type * as ApiClient from "../api/client";
import { buildApiClientError } from "../api/errors";
import { type PlacementAction, type PlacementState } from "../hooks/useIllustratorPlacement";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  assignFloors: vi.fn(),
  exportIllustrator: vi.fn(),
  previewIllustrator: vi.fn()
}));

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  canUndo: boolean;
  onExport: () => void;
  error: string | null;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, dispatch, canUndo, onExport, error }: SidebarProps) => (
    <section>
      <button type="button" onClick={() => dispatch({ type: "rotateFrame", rotationDeg: 30 })}>
        Rotate
      </button>
      <button type="button" onClick={onExport}>
        Export
      </button>
      <output data-testid="rotation">{state.frame.rotationDeg}</output>
      <output data-testid="can-undo">{String(canUndo)}</output>
      <output data-testid="sidebar-error">{error ?? ""}</output>
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  ARTWORK_TINT: "#ea580c",
  PlacementMap: () => <section data-testid="map" />
}));

const preview = vi.mocked(previewIllustrator);
const assign = vi.mocked(assignFloors);
const exportFiles = vi.mocked(exportIllustrator);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "first",
  report: {
    source_name: "tokyo.ai",
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

const EXPIRED = buildApiClientError(
  410,
  JSON.stringify({ detail: "That conversion has expired.", code: "CONVERSION_EXPIRED" })
);

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  exportFiles.mockReset();
  preview
    .mockResolvedValueOnce(PREVIEW)
    .mockResolvedValue({ ...PREVIEW, conversion_id: "second" });
  assign.mockResolvedValue({
    floors: [
      { label: "artwork", feature_count: 1, artwork_bounds: [0, 0, 200, 160], layer_counts: [] }
    ],
    unassigned_count: 0,
    total_features: 1
  });
  exportFiles
    .mockRejectedValueOnce(EXPIRED)
    .mockResolvedValue({ blob: new Blob(["zip"]), filename: "tokyo.zip" });
  URL.createObjectURL = vi.fn(() => "blob:tokyo");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

async function placeAndRotate() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "tokyo.ai")] }
  });
  fireEvent.click(await screen.findByRole("button", { name: /Skip/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));
  expect(screen.getByTestId("rotation")).toHaveTextContent("30");
}

test("an expired conversion is renewed under the same assignment and the export retried", async () => {
  await placeAndRotate();
  fireEvent.click(screen.getByRole("button", { name: "Export" }));

  await waitFor(() => expect(exportFiles).toHaveBeenCalledTimes(2));
  expect(exportFiles.mock.calls[1][0]).toBe("second");
  expect(exportFiles.mock.calls[1][1].floors[0].transform.rotation_deg).toBe(30);
  expect(assign).toHaveBeenCalledTimes(2);
  expect(assign.mock.calls[1]).toEqual(["second", assign.mock.calls[0][1]]);
  expect(URL.createObjectURL).toHaveBeenCalled();
  expect(screen.getByTestId("rotation")).toHaveTextContent("30");
  expect(screen.getByTestId("can-undo")).toHaveTextContent("true");
  expect(screen.getByTestId("sidebar-error")).toHaveTextContent("");
});

test("a file that no longer fits its assignment falls back to assigning again", async () => {
  await placeAndRotate();
  assign.mockRejectedValue(
    buildApiClientError(422, JSON.stringify({ detail: "No features in 1F.", code: "FLOOR_MISMATCH" }))
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/assign the floors again/i);
  expect(screen.getByRole("button", { name: /Skip/ })).toBeInTheDocument();
  expect(exportFiles).toHaveBeenCalledTimes(1);
});
