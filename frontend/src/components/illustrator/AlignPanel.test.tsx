import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { geocodeSearch, type GeocodeResultItem } from "../../api/client";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";
import type { FloorStatus } from "../../lib/floorStatus";
import { AlignPanel } from "./AlignPanel";
import type { AlignMethod } from "./ScaleAndFitPanel";

vi.mock("../../api/client", () => ({
  createPlacement: vi.fn(),
  deletePlacement: vi.fn(),
  geocodeSearch: vi.fn(),
  listPlacements: vi.fn(() => new Promise(() => {})),
  uploadReferenceLayers: vi.fn(),
  getPreloadedReferenceOverlay: vi.fn().mockResolvedValue({ available: false, label: "駅データ" }),
  fetchPreloadedReferenceLayers: vi.fn()
}));

function stateWith(floors: { label: string; linked: boolean; pinned?: boolean }[], active: string): PlacementState {
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

function Harness({
  siteName = "",
  placement = STATE,
  statuses = new Map()
}: {
  siteName?: string;
  placement?: PlacementState;
  statuses?: Map<string, FloorStatus>;
}) {
  const [method, setMethod] = useState<AlignMethod>("points");
  return (
    <AlignPanel
      state={placement}
      dispatch={() => {}}
      mode="group"
      siteName={siteName}
      conversionId="conversion-1"
      onLocate={() => {}}
      canUndo={false}
      canRedo={false}
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
        onClear: () => {},
        onCancel: () => {}
      }}
      alignMethod={method}
      onAlignMethodChange={setMethod}
      statuses={statuses}
      references={{ preloaded: true, uploads: [], removed: [], pin: null }}
      surveySnap={{ layerName: "", notice: null, onSnap: () => {} }}
      referenceLayers={[]}
      onReferenceLayersChange={() => {}}
    />
  );
}

const panels = () => [...document.querySelectorAll("[role=tabpanel][data-tab]")] as HTMLElement[];
const exposed = () => panels().filter((node) => !node.hasAttribute("hidden"));
// Radix selects a tab on mousedown, not on a bare synthetic click.
const clickTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
const openAdvanced = () => fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
const scaleInput = () => screen.getByText("1:").closest("div")!.querySelector("input")!;

test("the three methods stay mounted with exactly one exposed", () => {
  render(<Harness />);
  expect(panels().map((panel) => panel.dataset.tab)).toEqual(["move", "points", "shape"]);
  expect(exposed().map((panel) => panel.dataset.tab)).toEqual(["points"]);
  clickTab("Move");
  expect(exposed().map((panel) => panel.dataset.tab)).toEqual(["move"]);
  clickTab("Shape match");
  expect(exposed().map((panel) => panel.dataset.tab)).toEqual(["shape"]);
});

test("a typed drawing scale survives a method round trip", () => {
  render(<Harness />);
  openAdvanced();
  fireEvent.change(scaleInput(), { target: { value: "1234" } });
  clickTab("Move");
  clickTab("Control points");
  expect(scaleInput()).toHaveValue(1234);
});

test("apply and calibrate are disabled while the scale is locked", () => {
  render(<Harness placement={{ ...STATE, scaleLocked: true }} />);
  openAdvanced();
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Calibrate" })).toBeDisabled();
});

test("the header names the floor, its frame and its status", () => {
  const placement = stateWith(
    [
      { label: "1F", linked: true },
      { label: "2F", linked: true },
      { label: "3F", linked: false }
    ],
    "1F"
  );
  const { rerender } = render(<Harness placement={placement} />);
  expect(screen.getByRole("heading", { name: "Align 1F" })).toBeInTheDocument();
  expect(screen.getByText("Linked · 1F 2F")).toBeInTheDocument();
  expect(screen.getByText("Needs alignment")).toBeInTheDocument();
  rerender(
    <Harness
      placement={{ ...placement, activeFloorLabel: "3F" }}
      statuses={new Map([["3F", { kind: "aligned", basis: { kind: "reference", reference: { layer: "Station_pg", preloaded: true, uploads: [], pin: null } } }]])}
    />
  );
  expect(screen.getByText("Own frame")).toBeInTheDocument();
  expect(screen.getByText("Aligned")).toBeInTheDocument();
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

test("Nominatim hits stay out of the document until the locate row is opened", async () => {
  vi.mocked(geocodeSearch).mockResolvedValue([oimachiStaWire]);
  render(<Harness siteName="大井町" />);
  clickTab("Move");
  await waitFor(() => expect(screen.getByText(/suggested · approximate/i)).toBeInTheDocument());
  expect(screen.queryByText(oimachiStaWire.display_name)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /大井町/ }));
  expect(screen.getByRole("button", { name: oimachiStaWire.display_name })).toBeInTheDocument();
});
