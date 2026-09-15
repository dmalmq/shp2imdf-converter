import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import { PlacementSidebar, type PlacementTab } from "./PlacementSidebar";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";

vi.mock("../../api/client", () => ({
  createPlacement: vi.fn(),
  deletePlacement: vi.fn(),
  geocodeSearch: vi.fn(),
  listPlacements: vi.fn(() => new Promise(() => {})),
  uploadReferenceLayers: vi.fn(),
  getPreloadedReferenceOverlay: vi.fn().mockResolvedValue({ available: false, label: "駅データ" }),
  fetchPreloadedReferenceLayers: vi.fn()
}));

function stateWith(
  floors: { label: string; linked: boolean; pinned?: boolean }[],
  active: string
): PlacementState {
  return {
    frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
    activeFloorLabel: active,
    scaleLocked: false,
    floors: floors.map((floor) => ({
      label: floor.label,
      linked: floor.linked,
      pinned: floor.pinned ?? false,
      artworkAnchor: [50, 50] as [number, number],
      mapAnchor: [139.7671, 35.6812] as [number, number],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
    }))
  };
}

const STATE = stateWith([{ label: "1F", linked: true }], "1F");
const FORMATS = { geopackage: true, shapefile: true, qgis: true };

function SidebarHarness({
  siteName = "",
  placement = STATE
}: {
  siteName?: string;
  placement?: PlacementState;
}) {
  const [tab, setTab] = useState<PlacementTab>("fit");
  return (
    <PlacementSidebar
      state={placement}
      dispatch={() => {}}
      mode="group"
      siteName={siteName}
      conversionId="conversion-1"
      onLocate={() => {}}
      canUndo={false}
      canRedo={false}
      tab={tab}
      onTabChange={setTab}
      pickStage={null}
      onTogglePicking={() => {}}
      shapeMatch={{
        referenceName: "",
        referenceFloorLabel: "",
        selecting: false,
        selection: null,
        matches: [],
        previewRank: null,
        loading: false,
        searched: false,
        error: null,
        onReferenceChange: () => {},
        onMatchTargetChange: () => {},
        onToggleSelection: () => {},
        sourceFloorLabel: "1F",
        regionStage: null,
        hasSourceRegion: false,
        hasTargetRegion: false,
        onToggleRegions: () => {},
        onFind: () => {},
        onPreview: () => {},
        onInspect: () => {},
        onApply: () => {},
        onClear: () => {}
      }}
      surveySnap={{ layerName: "", notice: null, onSnap: () => {} }}
      referenceLayers={[]}
      onReferenceLayersChange={() => {}}
      bounds={[0, 0, 100, 100]}
      outputCrs={placement.frame.workingCrs}
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

// The Place tab now nests its own Control points / Shape match tabs, so a bare
// [role=tabpanel] query sees five panels. `data-tab` marks the three outer ones.
const outerPanels = () =>
  [...document.querySelectorAll("[role=tabpanel][data-tab]")] as HTMLElement[];
const exposedPanel = () => outerPanels().filter((node) => !node.hasAttribute("hidden"));

// Radix selects a tab on mousedown, not on a bare synthetic click, so
// `fireEvent.click` alone leaves the tab unchanged.
const clickTab = (name: string) =>
  fireEvent.mouseDown(screen.getByRole("tab", { name }));

// The drawing scale and pt/m calibration live behind the Advanced disclosure.
const openAdvanced = () => fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));

const scaleInput = () =>
  screen.getByText("1:").closest("div")!.querySelector("input")!;


test("all three panels stay in the DOM with exactly one exposed", () => {
  render(<SidebarHarness />);
  expect(outerPanels()).toHaveLength(3);
  expect(exposedPanel()).toHaveLength(1);
});

test("switching tabs flips which panel is exposed", () => {
  render(<SidebarHarness />);
  expect(exposedPanel()[0]).toHaveAttribute("data-tab", "fit");
  clickTab("Reference");
  expect(exposedPanel()[0]).toHaveAttribute("data-tab", "reference");
  clickTab("Export");
  expect(exposedPanel()[0]).toHaveAttribute("data-tab", "export");
});

test("a typed drawing scale survives a tab round trip", () => {
  render(<SidebarHarness />);
  openAdvanced();
  fireEvent.change(scaleInput(), { target: { value: "1234" } });
  expect(scaleInput()).toHaveValue(1234);
  clickTab("Reference");
  clickTab("Place");
  expect(scaleInput()).toHaveValue(1234);
});

test("the pinned scale lock stays visible on the Export tab", () => {
  render(<SidebarHarness placement={{ ...STATE, scaleLocked: true }} />);
  expect(screen.getByRole("button", { name: /^Unlock$/ })).toBeInTheDocument();
  expect(screen.getByText(/scale 1:1000/i)).toBeInTheDocument();
  clickTab("Export");
  expect(screen.getByRole("button", { name: /^Unlock$/ })).toBeInTheDocument();
  expect(screen.getByText(/scale 1:1000/i)).toBeInTheDocument();
});

test("Place-tab apply and calibrate are disabled while locked", () => {
  render(<SidebarHarness placement={{ ...STATE, scaleLocked: true }} />);
  openAdvanced();
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Calibrate" })).toBeDisabled();
});

const EMPTY_ADDRESS = {
  address: null,
  unit: null,
  locality: null,
  province: null,
  country: null,
  postal_code: null,
  postal_code_ext: null,
  postal_code_vanity: null
};

const oimachiStaWire: GeocodeResultItem = {
  display_name: "大井町駅, 品川区, 東京都",
  latitude: 35.6063,
  longitude: 139.7286,
  source: "nominatim",
  address: EMPTY_ADDRESS
};

const oimachiTownWire: GeocodeResultItem = {
  display_name: "大井町, 足柄上郡, 神奈川県",
  latitude: 35.322,
  longitude: 139.117,
  source: "nominatim",
  address: EMPTY_ADDRESS
};

test("the export CRS list follows the pin's working CRS, not the Tokyo seed", () => {
  const hakodate = {
    ...STATE,
    frame: { ...STATE.frame, workingCrs: "EPSG:6679" }
  };
  render(<SidebarHarness placement={hakodate} />);
  clickTab("Export");

  // The picker is a Radix Select now, so the current value reads off the
  // trigger and the choices only exist once it is open.
  const trigger = screen.getByRole("combobox", { name: "Output CRS" });
  expect(trigger).toHaveTextContent("EPSG:6679");

  fireEvent.click(trigger);
  expect(screen.getByRole("option", { name: /EPSG:6679/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /EPSG:6677/ })).toBeNull();
});

test("Nominatim hits stay out of the document until the locate row is opened", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire, oimachiTownWire]);
  render(<SidebarHarness siteName="大井町" />);
  await waitFor(() => expect(screen.getByText(/first match/i)).toBeInTheDocument());
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.queryByText(oimachiStaWire.display_name)).toBeNull();
  expect(screen.getByRole("tab", { name: "Place" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Reference" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Export" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  expect(screen.getByRole("button", { name: oimachiStaWire.display_name })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: oimachiTownWire.display_name })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Place" })).toBeInTheDocument();
  expect(exposedPanel()).toHaveLength(1);
});

