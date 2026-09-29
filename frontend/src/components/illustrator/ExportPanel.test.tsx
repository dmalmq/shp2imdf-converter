import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { listPlacements } from "../../api/client";
import type * as ApiClient from "../../api/client";
import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import type { FloorStatus } from "../../lib/floorStatus";
import { ExportPanel } from "./ExportPanel";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listPlacements: vi.fn()
}));

const floor = (label: string) => ({
  label,
  linked: true,
  pinned: false,
  artworkAnchor: [100, 80] as [number, number],
  mapAnchor: [139.7671, 35.6812] as [number, number],
  controlPoints: [],
  artworkBounds: [0, 0, 200, 160] as [number, number, number, number]
});

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [floor("1F"), floor("2F")],
  activeFloorLabel: "1F",
  scaleLocked: true
};

const ALIGNED: FloorStatus = { kind: "aligned", basis: { kind: "reference" } };

function renderPanel(statuses: Map<string, FloorStatus>) {
  const onExport = vi.fn();
  const onReviewFloor = vi.fn();
  render(
    <ExportPanel
      state={STATE}
      dispatch={vi.fn()}
      artworkBounds={[0, 0, 200, 160]}
      crsChoices={[{ value: "EPSG:6677", label: "EPSG:6677" }]}
      outputCrs="EPSG:6677"
      onOutputCrsChange={vi.fn()}
      formats={{ geopackage: false, shapefile: true, qgis: false }}
      onFormatsChange={vi.fn()}
      onExport={onExport}
      previewFeatures={2}
      totalFeatures={2}
      error={null}
      statuses={statuses}
      onReviewFloor={onReviewFloor}
    />
  );
  return { onExport, onReviewFloor };
}

beforeEach(() => {
  vi.mocked(listPlacements).mockResolvedValue([]);
});

test("an unaligned floor is listed with Review, and exporting asks once", () => {
  const { onExport, onReviewFloor } = renderPanel(
    new Map<string, FloorStatus>([
      ["1F", ALIGNED],
      ["2F", { kind: "needs-alignment", reason: "moved" }]
    ])
  );
  const list = screen.getByRole("list", { name: "Floor status" });
  expect(within(list).getByText("Needs alignment")).toBeInTheDocument();
  expect(within(list).getByText("Moved since it was aligned")).toBeInTheDocument();
  fireEvent.click(within(list).getByRole("button", { name: "Review 2F" }));
  expect(onReviewFloor).toHaveBeenCalledWith("2F");

  fireEvent.click(screen.getByRole("button", { name: "Export 2 floors" }));
  expect(onExport).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent("Export with 2F not aligned?");
  fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
  expect(onExport).toHaveBeenCalledOnce();
});

test("with every floor aligned, export runs at once", () => {
  const { onExport } = renderPanel(new Map([["1F", ALIGNED], ["2F", ALIGNED]]));
  fireEvent.click(screen.getByRole("button", { name: "Export 2 floors" }));
  expect(onExport).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
