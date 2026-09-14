import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Feature, Polygon } from "geojson";

import type { IllustratorShapeMatchSuggestion } from "../../api/client";

import {
  DEFAULT_METRES_PER_POINT,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import type { SimilarityTransform } from "../../lib/similarity";
import { PlacementMap, type FloorLayer } from "./PlacementMap";
import { artworkLayerFilter } from "./placementMapLayers";

const mapSpies = vi.hoisted(() => ({ fitBounds: vi.fn() }));
vi.mock("../shared/MapView", async () => {
  const React = await import("react");
  return {
    MapView: React.forwardRef(function MapViewMock(
      {
        onLoad,
        children,
        cursor
      }: {
        onLoad?: (event: { target: { getLayer: () => undefined } }) => void;
        children?: React.ReactNode;
        cursor?: string;
      },
      ref: React.ForwardedRef<unknown>
    ) {
      React.useImperativeHandle(ref, () => ({
        fitBounds: mapSpies.fitBounds,
        getMap: () => ({ getLayer: () => undefined })
      }));
      React.useEffect(() => {
        onLoad?.({ target: { getLayer: () => undefined } });
      }, [onLoad]);
      return React.createElement(
        "div",
        { "data-testid": "map-view", "data-cursor": cursor ?? "" },
        children
      );
    })
  };
});

vi.mock("react-map-gl/maplibre", () => ({
  Source: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Layer: ({ id, filter }: { id: string; filter?: unknown }) => (
    <div
      data-testid={`map-layer-${id}`}
      data-filter={filter === undefined ? "" : JSON.stringify(filter)}
    />
  ),
  Marker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}));

vi.mock("./TransformHandles", () => ({
  TransformHandles: () => <div data-testid="transform-handles" />
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

const LAYERS: FloorLayer[] = [
  { label: "1F", features: [], bounds: [0, 0, 1, 1], color: "#3b82f6" },
  { label: "2F", features: [], bounds: [0, 0, 1, 1], color: "#16a34a" }
];

function artworkFeature(layer: string, sourceRow: number): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {
      ai_layer: layer,
      source_table: layer,
      source_row: sourceRow
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [sourceRow * 10, 0],
          [sourceRow * 10 + 8, 0],
          [sourceRow * 10 + 8, 8],
          [sourceRow * 10, 8],
          [sourceRow * 10, 0]
        ]
      ]
    }
  };
}

const LAYERED_LAYERS: FloorLayer[] = [
  {
    ...LAYERS[0],
    features: [artworkFeature("Walls", 0), artworkFeature("Labels", 1)]
  },
  {
    ...LAYERS[1],
    features: [artworkFeature("Walls", 2)]
  }
];

const STATE = stateWith(
  [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ],
  "1F"
);

const PREVIEW_TRANSFORM: SimilarityTransform = {
  artworkAnchor: [50, 50],
  mapAnchor: [139.71, 35.69],
  rotationDeg: 0,
  metresPerPoint: DEFAULT_METRES_PER_POINT,
  workingCrs: "EPSG:6677"
};

const MATCH: IllustratorShapeMatchSuggestion = {
  rank: 2,
  score: 0.8,
  relative_gap: null,
  reference_feature_index: 1,
  reference_part_index: 0,
  transform: {
    artwork_anchor: PREVIEW_TRANSFORM.artworkAnchor,
    map_anchor: PREVIEW_TRANSFORM.mapAnchor,
    rotation_deg: PREVIEW_TRANSFORM.rotationDeg,
    metres_per_point: PREVIEW_TRANSFORM.metresPerPoint,
    working_crs: PREVIEW_TRANSFORM.workingCrs
  },
  boundary_rmse_m: 0.5,
  boundary_p95_m: 1,
  max_residual_m: 1.5,
  overlap_iou: 0.89,
  reference_geometry: {
    type: "Polygon",
    coordinates: [
      [
        [139.7, 35.68],
        [139.72, 35.68],
        [139.72, 35.7],
        [139.7, 35.7],
        [139.7, 35.68]
      ]
    ]
  },
  residual_vectors: []
};

function renderMap({
  layers = LAYERS,
  state = STATE,
  pickStage = null,
  shapePickActive = false,
  shapeMatchPreview = null
}: {
  layers?: FloorLayer[];
  state?: PlacementState;
  pickStage?: "artwork" | "map" | null;
  shapePickActive?: boolean;
  shapeMatchPreview?: {
    suggestion: IllustratorShapeMatchSuggestion;
    transform: SimilarityTransform;
  } | null;
} = {}) {
  return render(
    <PlacementMap
      floors={layers}
      state={state}
      dispatch={() => {}}
      mode="group"
      onModeChange={() => {}}
      pickStage={pickStage}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
      shapePickActive={shapePickActive}
      shapeMatchPreview={shapeMatchPreview}
    />
  );
}

test("transform handles mount when idle and stay unmounted during shape pick", async () => {
  const { rerender } = renderMap();
  await waitFor(() => expect(screen.getByTestId("transform-handles")).toBeInTheDocument());
  expect(screen.getByTestId("map-view")).toHaveAttribute("data-cursor", "");

  rerender(
    <PlacementMap
      floors={LAYERS}
      state={STATE}
      dispatch={() => {}}
      mode="group"
      onModeChange={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
      shapePickActive
    />
  );
  expect(screen.queryByTestId("transform-handles")).toBeNull();
  expect(screen.getByTestId("map-view")).toHaveAttribute("data-cursor", "crosshair");
});

test("transform handles stay unmounted while a control-point pair is being picked", async () => {
  renderMap({ pickStage: "artwork" });
  await waitFor(() => expect(screen.getByTestId("map-view")).toHaveAttribute("data-cursor", "crosshair"));
  expect(screen.queryByTestId("transform-handles")).toBeNull();
});

test("transform handles stay unmounted when the active floor is frozen in place", async () => {
  const frozen = stateWith(
    [
      { label: "1F", linked: false, pinned: true },
      { label: "2F", linked: true }
    ],
    "1F"
  );
  renderMap({ state: frozen });
  await waitFor(() => expect(screen.getByTestId("map-view")).toBeInTheDocument());
  expect(screen.queryByTestId("transform-handles")).toBeNull();
  expect(screen.getByRole("button", { name: "Unpin 1F" })).toBeEnabled();
});

test("map off shows drawing-only mode and can switch back to streets", () => {
  renderMap();
  const street = screen.getByRole("button", { name: "Street" });
  const mapOff = screen.getByRole("button", { name: "Map off" });

  expect(street).toHaveAttribute("aria-pressed", "true");
  expect(mapOff).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(mapOff);
  expect(street).toHaveAttribute("aria-pressed", "false");
  expect(mapOff).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(street);
  expect(street).toHaveAttribute("aria-pressed", "true");
  expect(mapOff).toHaveAttribute("aria-pressed", "false");
});

test("artwork layers can be hidden independently for each floor", () => {
  renderMap({ layers: LAYERED_LAYERS });
  const trigger = screen.getByRole("button", { name: "Artwork layers" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  const walls1F = screen.getByRole("checkbox", { name: "Walls on 1F" });
  const walls2F = screen.getByRole("checkbox", { name: "Walls on 2F" });
  expect(walls1F).toBeChecked();
  expect(walls2F).toBeChecked();

  fireEvent.click(walls1F);
  expect(walls1F).not.toBeChecked();
  expect(walls2F).toBeChecked();
  expect(trigger).toHaveAccessibleName("Artwork layers, 1 hidden");
  expect(screen.getByTestId("map-layer-floor-1F-fill")).toHaveAttribute(
    "data-filter",
    JSON.stringify(artworkLayerFilter(["Walls"], true))
  );

  fireEvent.click(screen.getByRole("button", { name: "Hide all layers on 2F" }));
  expect(walls2F).not.toBeChecked();
  expect(trigger).toHaveAccessibleName("Artwork layers, 2 hidden");
  fireEvent.click(screen.getByRole("button", { name: "Show all layers on 2F" }));
  expect(walls2F).toBeChecked();
  expect(trigger).toHaveAccessibleName("Artwork layers, 1 hidden");
});

test("a highlighted match frames its reference area", async () => {
  mapSpies.fitBounds.mockClear();
  renderMap({ shapeMatchPreview: { suggestion: MATCH, transform: PREVIEW_TRANSFORM } });

  await waitFor(() =>
    expect(mapSpies.fitBounds).toHaveBeenCalledWith(
      [
        [139.7, 35.68],
        [139.72, 35.7]
      ],
      { padding: 72, duration: 350, maxZoom: 19 }
    )
  );
});
