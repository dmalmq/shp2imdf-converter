import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import type { FloorStatus } from "../../lib/floorStatus";
import { ArtworkDeliver } from "./ArtworkDeliver";

const floor = (label: string, linked = true) => ({
  label,
  linked,
  pinned: false,
  artworkAnchor: [100, 80] as [number, number],
  mapAnchor: [139.7671, 35.6812] as [number, number],
  controlPoints: [],
  artworkBounds: [0, 0, 200, 160] as [number, number, number, number]
});

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [floor("1F"), floor("2F", false)],
  activeFloorLabel: "1F",
  scaleLocked: true
};

const ALIGNED: FloorStatus = { kind: "aligned", basis: { kind: "reference", reference: { layer: "Station_pg", preloaded: true, uploads: [], pin: null } } };

function renderDeliver(statuses: Map<string, FloorStatus>) {
  const onExport = vi.fn();
  const onReview = vi.fn();
  render(
    <ArtworkDeliver
      state={STATE}
      statuses={statuses}
      references={{ preloaded: true, uploads: [], removed: [], pin: null }}
      station="東京"
      stem="0001_東京"
      floors={[
        { label: "1F", pages: [1], box: false, shapes: 12 },
        { label: "2F", pages: [2], box: true, shapes: 7 }
      ]}
      shapesFromPreview={false}
      crsChoices={[
        { value: "EPSG:6679", label: "EPSG:6679 — JPR CS XI" },
        { value: "EPSG:4326", label: "EPSG:4326 — WGS84 lon/lat" }
      ]}
      outputCrs="EPSG:6679"
      onOutputCrsChange={vi.fn()}
      formats={{ geopackage: false, shapefile: true, qgis: false }}
      onFormatsChange={vi.fn()}
      onExport={onExport}
      error={null}
      onReview={onReview}
      onBackToMap={vi.fn()}
    />
  );
  return { onExport, onReview };
}

test("the per-floor table lists each floor's source, status and frame, with Review where it is needed", () => {
  const { onReview } = renderDeliver(
    new Map<string, FloorStatus>([
      ["1F", ALIGNED],
      ["2F", { kind: "needs-alignment", reason: "moved" }]
    ])
  );
  const table = screen.getByRole("table", { name: "Floor status" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows[0]).toHaveTextContent("1FPage 112Aligned");
  expect(rows[0]).toHaveTextContent("Shape match to reference");
  expect(rows[1]).toHaveTextContent("Page 2 · box");
  expect(rows[1]).toHaveTextContent("Moved since it was aligned");
  expect(rows[1]).toHaveTextContent("own frame");
  fireEvent.click(within(rows[1]).getByRole("button", { name: "Review 2F" }));
  expect(onReview).toHaveBeenCalledWith("2F");
});

test("exporting with a floor not aligned asks once, and Export anyway runs it", () => {
  const { onExport } = renderDeliver(new Map([["1F", ALIGNED]]));
  expect(screen.getByText("2F still needs alignment.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Export 2 floors/ }));
  expect(onExport).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toHaveTextContent("Export with 2F not aligned?");
  fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
  expect(onExport).toHaveBeenCalledOnce();
});

test("with every floor aligned, export runs at once and the CRS picker follows the working CRS", () => {
  const { onExport } = renderDeliver(new Map([["1F", ALIGNED], ["2F", ALIGNED]]));
  expect(screen.getByText("All 2 floors are aligned.")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Output CRS" })).toHaveTextContent("EPSG:6679");
  fireEvent.click(screen.getByRole("button", { name: /Export 2 floors/ }));
  expect(onExport).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
