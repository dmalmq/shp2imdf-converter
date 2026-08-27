import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Feature, Polygon } from "geojson";

import type { IllustratorShapeMatchSuggestion } from "../../api/client";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";
import type { ArtworkShapeSelection, ReferenceLayer } from "./PlacementMap";
import { ShapeMatchPanel, type ShapeMatchPanelModel } from "./ShapeMatchPanel";

const feature: Feature<Polygon> = {
  type: "Feature",
  properties: { source_table: "Fill_Layer", source_row: 0 },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]]]
  }
};

const selection: ArtworkShapeSelection = {
  floorLabel: "1F",
  sourceTable: "Fill_Layer",
  sourceRow: 0,
  feature
};

const match: IllustratorShapeMatchSuggestion = {
  rank: 1,
  score: 0.08,
  relative_gap: 0.24,
  reference_feature_index: 4,
  reference_part_index: 0,
  transform: {
    artwork_anchor: [50, 40],
    map_anchor: [139.7671, 35.6812],
    rotation_deg: 12.5,
    metres_per_point: 0.42,
    working_crs: "EPSG:6677"
  },
  boundary_rmse_m: 1.25,
  boundary_p95_m: 2.5,
  max_residual_m: 3.1,
  overlap_iou: 0.88,
  reference_geometry: {
    type: "Polygon",
    coordinates: [[[139.7, 35.6], [139.8, 35.6], [139.8, 35.7], [139.7, 35.6]]]
  },
  residual_vectors: []
};

const referenceLayers: ReferenceLayer[] = [
  {
    name: "building-footprints",
    data: { type: "FeatureCollection", features: [] },
    color: "#0f766e",
    visible: true,
    featureCount: 8,
    truncated: false
  }
];

function floorPlacement(label: string, linked: boolean) {
  return {
    label,
    linked,
    artworkAnchor: [50, 40] as [number, number],
    mapAnchor: [139.7671, 35.6812] as [number, number],
    controlPoints: [],
    artworkBounds: [0, 0, 100, 80] as [number, number, number, number],
    ...(linked ? {} : { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT })
  };
}

function placementState(linked = true, labels: string[] = ["1F"]): PlacementState {
  return {
    frame: {
      rotationDeg: 0,
      metresPerPoint: DEFAULT_METRES_PER_POINT,
      workingCrs: "EPSG:6677"
    },
    activeFloorLabel: labels[0],
    scaleLocked: false,
    floors: labels.map((label) => floorPlacement(label, linked))
  };
}

function model(overrides: Partial<ShapeMatchPanelModel> = {}): ShapeMatchPanelModel {
  return {
    referenceName: "building-footprints",
    referenceFloorLabel: "",
    selecting: false,
    selection: null,
    matches: [],
    previewRank: null,
    loading: false,
    searched: false,
    error: null,
    sourceFloorLabel: "1F",
    regionStage: null,
    hasSourceRegion: false,
    hasTargetRegion: false,
    onToggleRegions: vi.fn(),
    onReferenceChange: vi.fn(),
    onMatchTargetChange: vi.fn(),
    onToggleSelection: vi.fn(),
    onFind: vi.fn(),
    onPreview: vi.fn(),
    onApply: vi.fn(),
    onClear: vi.fn(),
    ...overrides
  };
}

test("directs the user to add a reference layer before matching", () => {
  render(
    <ShapeMatchPanel
      state={placementState()}
      mode="group"
      referenceLayers={[]}
      model={model({ referenceName: "" })}
    />
  );
  expect(
    screen.getByText("Add a shapefile in the Reference tab, or assign more than one floor.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose outline" })).toBeDisabled();
});

test("another floor is enough to start matching without a shapefile", () => {
  const onMatchTargetChange = vi.fn();
  render(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({ referenceName: "", referenceFloorLabel: "2F", onMatchTargetChange })}
    />
  );
  expect(screen.getByRole("button", { name: "Choose outline" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Match against" })).toHaveValue("floor:2F");
  fireEvent.change(screen.getByRole("combobox", { name: "Match against" }), {
    target: { value: "floor:2F" }
  });
  expect(onMatchTargetChange).toHaveBeenCalled();
});

test("applying a floor match unlinks only this floor, even in group mode", () => {
  const onApply = vi.fn();
  render(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({
        referenceName: "",
        referenceFloorLabel: "2F",
        selection,
        matches: [match],
        previewRank: 1,
        searched: true,
        onApply
      })}
    />
  );
  expect(screen.getByRole("button", { name: "Apply to this floor" })).toBeEnabled();
  expect(
    screen.getByText("This floor will unlink so the other level keeps its position.")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Apply to this floor" }));
  expect(onApply).toHaveBeenCalledOnce();
});

test("selects an outline and searches only from explicit actions", () => {
  const onToggleSelection = vi.fn();
  const onFind = vi.fn();
  const { rerender } = render(
    <ShapeMatchPanel
      state={placementState()}
      mode="group"
      referenceLayers={referenceLayers}
      model={model({ onToggleSelection, onFind })}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose outline" }));
  expect(onToggleSelection).toHaveBeenCalledOnce();
  expect(onFind).not.toHaveBeenCalled();

  rerender(
    <ShapeMatchPanel
      state={placementState()}
      mode="group"
      referenceLayers={referenceLayers}
      model={model({ selection, onToggleSelection, onFind })}
    />
  );
  expect(screen.getByText("Outline selected on 1F.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Find matches" }));
  expect(onFind).toHaveBeenCalledOnce();
});

test("previews and applies a ranked suggestion only from explicit buttons", () => {
  const onPreview = vi.fn();
  const onApply = vi.fn();
  render(
    <ShapeMatchPanel
      state={placementState()}
      mode="individual"
      referenceLayers={referenceLayers}
      model={model({
        selection,
        matches: [match],
        previewRank: 1,
        searched: true,
        onPreview,
        onApply
      })}
    />
  );

  expect(screen.getByText("88% overlap")).toBeInTheDocument();
  expect(screen.getByText("RMSE 1.25 m")).toBeInTheDocument();
  expect(screen.getByText("24% better than next")).toBeInTheDocument();
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview candidate 1" }));
  expect(onPreview).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole("button", { name: "Apply to this floor" }));
  expect(onApply).toHaveBeenCalledOnce();
});

test("blocks group apply while the registration floor is unlinked", () => {
  render(
    <ShapeMatchPanel
      state={placementState(false)}
      mode="group"
      referenceLayers={referenceLayers}
      model={model({ selection, matches: [match], previewRank: 1, searched: true })}
    />
  );
  expect(screen.getByRole("button", { name: "Apply to all linked floors" })).toBeDisabled();
  expect(screen.getByText("Relink 1F before applying to all floors.")).toBeInTheDocument();
});


test("areas are offered only against another floor, and guide each drag", () => {
  const onToggleRegions = vi.fn();
  const { rerender } = render(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({ referenceName: "", referenceFloorLabel: "2F", onToggleRegions })}
    />
  );
  expect(
    screen.getByText("Use areas when only part of the two floors is the same.")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Match areas instead" }));
  expect(onToggleRegions).toHaveBeenCalledOnce();

  rerender(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({ referenceName: "", referenceFloorLabel: "2F", regionStage: "source" })}
    />
  );
  expect(
    screen.getByRole("button", { name: "Drag around the area on 1F…" })
  ).toBeInTheDocument();

  rerender(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({
        referenceName: "",
        referenceFloorLabel: "2F",
        regionStage: "target",
        hasSourceRegion: true
      })}
    />
  );
  expect(
    screen.getByRole("button", { name: "Now drag the matching area on 2F…" })
  ).toBeInTheDocument();

  // A shapefile target has no second floor to box, so the control is absent.
  rerender(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={referenceLayers}
      model={model({ referenceFloorLabel: "" })}
    />
  );
  expect(screen.queryByRole("button", { name: /Match areas instead/ })).toBeNull();
});

test("two picked areas can be compared without selecting any outline", () => {
  const onFind = vi.fn();
  render(
    <ShapeMatchPanel
      state={placementState(true, ["1F", "2F"])}
      mode="group"
      referenceLayers={[]}
      model={model({
        referenceName: "",
        referenceFloorLabel: "2F",
        selection: null,
        hasSourceRegion: true,
        hasTargetRegion: true,
        onFind
      })}
    />
  );
  expect(screen.getByText("Areas selected on 1F and 2F.")).toBeInTheDocument();
  const find = screen.getByRole("button", { name: "Find matches" });
  expect(find).toBeEnabled();
  fireEvent.click(find);
  expect(onFind).toHaveBeenCalledOnce();
});
