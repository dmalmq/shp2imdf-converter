import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { PlacementSidebar, type PlacementTab } from "./PlacementSidebar";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";

// PlacementLibrary (inside ExportPanel) fetches on mount; keep the sidebar
// render deterministic without a backend. The promise never resolves so the
// async refresh cannot set state outside act().
vi.mock("../../api/client", () => ({
  createPlacement: vi.fn(),
  deletePlacement: vi.fn(),
  geocodeSearch: vi.fn(),
  listPlacements: vi.fn(() => new Promise(() => {})),
  uploadReferenceLayers: vi.fn()
}));

function stateWith(floors: { label: string; linked: boolean }[], active: string): PlacementState {
  return {
    frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
    activeFloorLabel: active,
    scaleLocked: false,
    floors: floors.map((floor) => ({
      label: floor.label,
      linked: floor.linked,
      artworkAnchor: [50, 50] as [number, number],
      mapAnchor: [139.7671, 35.6812] as [number, number],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
    }))
  };
}

const STATE = stateWith([{ label: "1F", linked: true }], "1F");
const FORMATS = { geopackage: true, shapefile: true, qgis: true };

function SidebarHarness() {
  const [tab, setTab] = useState<PlacementTab>("fit");
  return (
    <PlacementSidebar
      state={STATE}
      dispatch={() => {}}
      mode="group"
      siteName=""
      onLocate={() => {}}
      canUndo={false}
      canRedo={false}
      tab={tab}
      onTabChange={setTab}
      picking={false}
      onTogglePicking={() => {}}
      referenceLayers={[]}
      onReferenceLayersChange={() => {}}
      bounds={[0, 0, 100, 100]}
      suggestedCrs="EPSG:6677"
      suggestedCrsLabel="EPSG:6677 — JGD2011 / Japan Plane Rectangular CS IX"
      outputCrs="EPSG:4326"
      onOutputCrsChange={() => {}}
      formats={FORMATS}
      onFormatsChange={() => {}}
      onExport={() => {}}
      previewFeatures={0}
      totalFeatures={0}
      error={null}
    />
  );
}

const scaleInput = () =>
  // The drawing-scale row is "1:" followed by its number input.
  screen.getByText("1:").closest("div")!.querySelector("input")!;


test("all three panels stay in the DOM with exactly one exposed", () => {
  render(<SidebarHarness />);
  // Conditional rendering ({tab === "fit" && ...}) would pass this DOM-wide
  // query only by luck of the active tab; the point is that remounting on tab
  // switch would discard typed values, so the panels are hidden, not removed.
  expect(document.querySelectorAll("[role=tabpanel]")).toHaveLength(3);
  // Only one is visible to the accessibility tree.
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
});

test("switching tabs flips which panel is exposed", () => {
  render(<SidebarHarness />);
  expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "placement-panel-fit");
  fireEvent.click(screen.getByRole("tab", { name: "Reference" }));
  expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "placement-panel-reference");
  fireEvent.click(screen.getByRole("tab", { name: "Export" }));
  expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "placement-panel-export");
});

test("a typed drawing scale survives a tab round trip", () => {
  render(<SidebarHarness />);
  fireEvent.change(scaleInput(), { target: { value: "1234" } });
  expect(scaleInput()).toHaveValue(1234);
  // Switch away and back: the Scale & fit panel must not have been unmounted,
  // or its local `denominator` state would re-initialise to 1000.
  fireEvent.click(screen.getByRole("tab", { name: "Reference" }));
  fireEvent.click(screen.getByRole("tab", { name: "Scale & fit" }));
  expect(scaleInput()).toHaveValue(1234);
});
