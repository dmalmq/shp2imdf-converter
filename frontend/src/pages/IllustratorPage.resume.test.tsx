import React, { type Dispatch } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
  previewIllustrator,
  saveIllustratorDraft,
  snapIllustratorSurvey,
  type IllustratorConversionResponse,
  type PlacementDraft
} from "../api/client";
import type * as ApiClient from "../api/client";
import type { ReferenceLayer } from "../components/illustrator/PlacementMap";
import type { PlacementTab } from "../components/illustrator/PlacementSidebar";
import { type PlacementAction, type PlacementState } from "../hooks/useIllustratorPlacement";
import { IllustratorPage } from "./IllustratorPage";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  previewIllustrator: vi.fn(),
  saveIllustratorDraft: vi.fn(),
  snapIllustratorSurvey: vi.fn()
}));

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  tab: PlacementTab;
  mode: string;
  outputCrs: string;
  onReferenceLayersChange: (layers: ReferenceLayer[]) => void;
};

const STATION_PG: ReferenceLayer = {
  name: "Station_pg",
  data: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: null,
        geometry: {
          type: "Polygon",
          coordinates: [[[139.767, 35.681], [139.768, 35.681], [139.768, 35.682], [139.767, 35.681]]]
        }
      }
    ]
  },
  color: "#2563eb",
  visible: true,
  featureCount: 1,
  truncated: false
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, dispatch, tab, mode, outputCrs, onReferenceLayersChange }: SidebarProps) => (
    <section>
      <button type="button" onClick={() => dispatch({ type: "rotateFrame", rotationDeg: 45 })}>
        Rotate
      </button>
      <button type="button" onClick={() => onReferenceLayersChange([STATION_PG])}>
        Survey
      </button>
      <output data-testid="rotation">{state.frame.rotationDeg}</output>
      <output data-testid="active">{state.activeFloorLabel}</output>
      <output data-testid="anchor-2F">{JSON.stringify(state.floors.find((f) => f.label === "2F")?.mapAnchor)}</output>
      <output data-testid="tab">{tab}</output>
      <output data-testid="mode">{mode}</output>
      <output data-testid="output-crs">{outputCrs}</output>
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  ARTWORK_TINT: "#7a3b7e",
  PlacementMap: () => <section data-testid="map" />
}));

const save = vi.mocked(saveIllustratorDraft);
const snap = vi.mocked(snapIllustratorSurvey);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "c".repeat(32),
  report: {
    source_name: "tokyo.ai",
    page_count: 1,
    pages: [{ index: 1, width_pt: 200, height_pt: 200 }],
    total_features: 1,
    layers: {},
    warnings: []
  },
  layers: [],
  pages: [
    { index: 1, bounds: [0, 0, 200, 200], width_pt: 200, height_pt: 200, feature_count: 1, preview_feature_count: 1 }
  ],
  artwork_bounds: [0, 0, 200, 200],
  preview: { type: "FeatureCollection", features: [] },
  preview_features: 0,
  total_features: 1,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "EPSG:6677 — JPR CS IX"
};

const FLOORS: IllustratorConversionResponse["floors"] = [
  { label: "1F", box: [0, 0, 100, 200], pages: null, layer_names: null },
  { label: "2F", box: [100, 0, 200, 200], pages: null, layer_names: null }
];

function floor(label: string, anchor: [number, number], box: [number, number, number, number]) {
  return {
    label,
    linked: label === "1F",
    pinned: false,
    artwork_anchor: [(box[0] + box[2]) / 2, 100] as [number, number],
    map_anchor: anchor,
    artwork_bounds: box,
    rotation_deg: label === "1F" ? null : 7.25,
    metres_per_point: label === "1F" ? null : 0.3,
    artwork_match: false,
    control_points: []
  };
}

const DRAFT: PlacementDraft = {
  version: 1,
  placement: {
    frame: { rotation_deg: 30, metres_per_point: 0.35, working_crs: "EPSG:6677" },
    floors: [
      floor("1F", [139.7671, 35.6812], [0, 0, 100, 200]),
      floor("2F", [139.76723456789, 35.68134567891], [100, 0, 200, 200])
    ],
    scale_locked: true,
    output_crs: "EPSG:4326",
    formats: { geopackage: false, shapefile: true, qgis: false }
  },
  view: {
    active_floor_label: "2F",
    mode: "individual",
    tab: "export",
    station_pin: [139.7671, 35.6812],
    location: null,
    references: { preloaded: true, include_lines: false, hidden: [], removed: [], uploads: [] }
  }
};

function conversion(overrides: Partial<IllustratorConversionResponse> = {}): IllustratorConversionResponse {
  return {
    conversion_id: PREVIEW.conversion_id,
    preview: PREVIEW,
    floors: FLOORS,
    project: {
      name: "tokyo",
      updated_at: null,
      content_changed_at: null,
      delivered_at: null,
      floors_total: 2,
      floors_placed: 0,
      stage: "place",
      blockers: 2
    },
    draft: DRAFT,
    draft_revision: 4,
    ...overrides
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  save.mockReset();
  snap.mockReset();
  vi.mocked(previewIllustrator).mockReset();
  save.mockResolvedValue({ revision: 5, changed: true, project: conversion().project });
});

afterEach(() => {
  vi.useRealTimers();
});

test("reopening restores the placement and view, sends nothing, and never re-snaps", async () => {
  render(<IllustratorPage restored={conversion()} />);

  expect(screen.getByTestId("rotation")).toHaveTextContent("30");
  expect(screen.getByTestId("active")).toHaveTextContent("2F");
  expect(screen.getByTestId("anchor-2F")).toHaveTextContent("[139.76723456789,35.68134567891]");
  expect(screen.getByTestId("tab")).toHaveTextContent("export");
  expect(screen.getByTestId("mode")).toHaveTextContent("individual");
  expect(screen.getByTestId("output-crs")).toHaveTextContent("EPSG:4326");

  fireEvent.click(screen.getByRole("button", { name: "Survey" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(snap).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(previewIllustrator).not.toHaveBeenCalled();
});

test("an edit after reopening is saved on the stored revision", async () => {
  render(<IllustratorPage restored={conversion()} />);
  fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(save).toHaveBeenCalledTimes(1);
  const [id, revision, sent] = save.mock.calls[0];
  expect([id, revision]).toEqual([PREVIEW.conversion_id, 4]);
  expect(sent.placement.frame.rotation_deg).toBe(45);
  expect(sent.placement.floors[1]).toEqual(DRAFT.placement.floors[1]);
});

test("an assignment with no saved placement opens placement from the assignment", () => {
  render(<IllustratorPage restored={conversion({ draft: null })} />);
  expect(screen.getByTestId("rotation")).toHaveTextContent("0");
  expect(screen.getByTestId("active")).toHaveTextContent("1F");
  expect(screen.getByTestId("tab")).toHaveTextContent("fit");
});

test("a project with no floors yet opens on naming them", () => {
  render(<IllustratorPage restored={conversion({ floors: null, draft: null, draft_revision: 0 })} />);
  expect(screen.getByRole("heading", { name: "Mark each floor" })).toBeInTheDocument();
});
