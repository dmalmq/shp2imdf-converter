import React, { type Dispatch } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureCollection, Polygon } from "geojson";

import { assignFloors, previewIllustrator, snapIllustratorSurvey } from "../api/client";
import type * as ApiClient from "../api/client";
import type { SurveySnapModel } from "../components/illustrator/PlacementSidebar";
import {
  DEFAULT_METRES_PER_POINT,
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

function overlay(name: string, data: FeatureCollection<Polygon>) {
  return {
    name,
    data,
    color: "#0f766e",
    visible: true,
    featureCount: data.features.length,
    truncated: false
  };
}

const STATION_PG = overlay("Station_pg", squares(5, 140.113));
const STATION_PL = overlay("Station_pl", squares(2, 140.114));
const PARCELS = overlay("parcels", squares(3, 140.115));

type SidebarProps = {
  state: PlacementState;
  dispatch: Dispatch<PlacementAction>;
  mode: AdjustmentMode;
  surveySnap: SurveySnapModel;
  onReferenceLayersChange: (layers: (typeof STATION_PG)[]) => void;
};

vi.mock("../components/illustrator/PlacementSidebar", () => ({
  PlacementSidebar: ({ state, dispatch, surveySnap, onReferenceLayersChange }: SidebarProps) => (
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
      <button type="button" onClick={() => onReferenceLayersChange([STATION_PG, STATION_PL])}>
        Add Station_pg
      </button>
      <button
        type="button"
        onClick={() =>
          onReferenceLayersChange([
            { ...STATION_PG, data: { ...STATION_PG.data, features: [...STATION_PG.data.features] } },
            STATION_PL
          ])
        }
      >
        Re-trim Station_pg
      </button>
      <button type="button" onClick={() => onReferenceLayersChange([PARCELS])}>
        Add parcels
      </button>
      <button type="button" onClick={() => dispatch({ type: "rotateFrame", rotationDeg: 30 })}>
        Nudge
      </button>
      <button type="button" disabled={!surveySnap.layerName} onClick={surveySnap.onSnap}>
        {`Snap to ${surveySnap.layerName || "nothing"}`}
      </button>
      <output data-testid="frame-rotation">{state.frame.rotationDeg}</output>
      <output data-testid="frame-metres">{state.frame.metresPerPoint}</output>
      <output data-testid="linked-floors">
        {state.floors.map((floor) => String(floor.linked)).join(",")}
      </output>
      <output data-testid="survey-notice">{surveySnap.notice ?? "none"}</output>
      <output data-testid="floor-labels">{state.floors.map((floor) => floor.label).join(",")}</output>
    </section>
  )
}));

vi.mock("../components/illustrator/PlacementMap", () => ({
  ARTWORK_TINT: "#ea580c",
  PlacementMap: () => <section data-testid="map" />
}));

const preview = vi.mocked(previewIllustrator);
const assign = vi.mocked(assignFloors);
const snap = vi.mocked(snapIllustratorSurvey);

const PREVIEW: ApiClient.IllustratorPreviewResponse = {
  conversion_id: "survey-test",
  report: {
    source_name: "0989_千葉.ai",
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
  preview: { type: "FeatureCollection", features: [] },
  preview_features: 0,
  total_features: 3,
  suggested_crs: "EPSG:6677",
  suggested_crs_label: "JGD2011 / Japan Plane Rectangular CS IX"
};

const MATCH: ApiClient.IllustratorShapeMatchSuggestion = {
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
};

function summary(labels: string[]): ApiClient.AssignFloorsResponse {
  return {
    floors: labels.map((label) => ({
      label,
      feature_count: 1,
      artwork_bounds: [0, 0, 200, 160],
      layer_counts: []
    })),
    unassigned_count: 0,
    total_features: 3
  };
}

beforeEach(() => {
  preview.mockReset();
  assign.mockReset();
  snap.mockReset();
  preview.mockResolvedValue(PREVIEW);
  assign.mockResolvedValue(summary(["1F", "2F", "3F"]));
  snap.mockResolvedValue({ match: MATCH, reason: null });
});

async function uploadArtwork() {
  render(<IllustratorPage />);
  const input = document.getElementById("illustrator-georef-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([37, 80, 68, 70])], "0989_千葉.ai")] }
  });
  await screen.findByRole("button", { name: "Done assigning" });
}

async function enterPlacementView() {
  await uploadArtwork();
  fireEvent.click(screen.getByRole("button", { name: "Done assigning" }));
  await screen.findByRole("button", { name: "Add Station_pg" });
}

test("Skip stores one artwork floor so the placement can snap", async () => {
  assign.mockResolvedValue(summary(["artwork"]));
  await uploadArtwork();
  fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
  await screen.findByRole("button", { name: "Add Station_pg" });
  expect(assign).toHaveBeenCalledWith("survey-test", [
    { label: "artwork", box: [0, 0, 200, 160], pages: null, layer_names: null }
  ]);
  expect(screen.getByTestId("floor-labels")).toHaveTextContent("artwork");
});

test("snaps every linked floor onto Station_pg once, and again only after a re-trim", async () => {
  await enterPlacementView();
  fireEvent.click(screen.getByRole("button", { name: "Pin station" }));
  fireEvent.click(screen.getByRole("button", { name: "Add Station_pg" }));

  await waitFor(() => expect(screen.getByTestId("frame-rotation")).toHaveTextContent("-36.4"));
  expect(snap).toHaveBeenCalledTimes(1);
  expect(snap).toHaveBeenCalledWith(
    "survey-test",
    expect.objectContaining({ scale_locked: true, reference: STATION_PG.data })
  );
  expect(snap.mock.calls[0][1].current_transform.metres_per_point).toBe(DEFAULT_METRES_PER_POINT);
  expect(screen.getByTestId("linked-floors")).toHaveTextContent("true,true,true");
  // The server's metres_per_point rides along but a locked frame keeps its own.
  expect(screen.getByTestId("frame-metres")).toHaveTextContent(String(DEFAULT_METRES_PER_POINT));
  expect(screen.getByTestId("survey-notice")).toHaveTextContent("92%");

  fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("30");
  expect(snap).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Re-trim Station_pg" }));
  await waitFor(() => expect(snap).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByTestId("frame-rotation")).toHaveTextContent("-36.4"));
});

test("a layer that is not Station_pg never snaps, and a failed consensus only notes it", async () => {
  await enterPlacementView();
  fireEvent.click(screen.getByRole("button", { name: "Pin station" }));
  fireEvent.click(screen.getByRole("button", { name: "Add parcels" }));
  expect(screen.getByRole("button", { name: "Snap to nothing" })).toBeDisabled();

  snap.mockResolvedValue({ match: null, reason: "no_consensus" });
  fireEvent.click(screen.getByRole("button", { name: "Add Station_pg" }));
  await waitFor(() => expect(screen.getByTestId("survey-notice")).toHaveTextContent(/no consensus/i));
  expect(snap).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("frame-rotation")).toHaveTextContent("0");

  snap.mockResolvedValue({ match: MATCH, reason: null });
  fireEvent.click(screen.getByRole("button", { name: "Snap to Station_pg" }));
  await waitFor(() => expect(screen.getByTestId("frame-rotation")).toHaveTextContent("-36.4"));
  expect(snap).toHaveBeenCalledTimes(2);
});
