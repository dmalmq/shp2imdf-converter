import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import {
  DEFAULT_METRES_PER_POINT,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { PlacementMap, type FloorLayer } from "./PlacementMap";

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
      _ref: unknown
    ) {
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
  Layer: () => null,
  Marker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}));

vi.mock("./TransformHandles", () => ({
  TransformHandles: () => <div data-testid="transform-handles" />
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

const LAYERS: FloorLayer[] = [
  { label: "1F", features: [], bounds: [0, 0, 1, 1], color: "#3b82f6" },
  { label: "2F", features: [], bounds: [0, 0, 1, 1], color: "#16a34a" }
];

const STATE = stateWith(
  [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ],
  "1F"
);

function renderMap({
  pickStage = null,
  shapePickActive = false
}: {
  pickStage?: "artwork" | "map" | null;
  shapePickActive?: boolean;
} = {}) {
  return render(
    <PlacementMap
      floors={LAYERS}
      state={STATE}
      dispatch={() => {}}
      mode="group"
      onModeChange={() => {}}
      pickStage={pickStage}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
      shapePickActive={shapePickActive}
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
