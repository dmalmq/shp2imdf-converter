import React from "react";
import { render } from "@testing-library/react";

import { MapPanel } from "./MapPanel";
import type { ReviewFeature } from "./types";

const fitBounds = vi.fn();

// MapView owns a real MapLibre instance, which jsdom cannot run. The stub hands
// back the two calls MapPanel makes on the ref and fires `onLoad`, which is the
// gate every framing effect waits on.
vi.mock("../shared/MapView", () => ({
  MapView: React.forwardRef<unknown, { onLoad?: () => void; children?: React.ReactNode }>(
    function MapViewStub({ onLoad, children }, ref) {
      React.useImperativeHandle(ref, () => ({
        fitBounds,
        getMap: () => ({
          getLayer: () => null,
          setLayoutProperty: () => {},
          setPaintProperty: () => {}
        })
      }));
      React.useEffect(() => {
        onLoad?.();
      }, [onLoad]);
      return <div data-testid="map">{children}</div>;
    }
  )
}));

vi.mock("react-map-gl/maplibre", () => ({
  Layer: () => null,
  Source: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

function square(id: string, levelId: string, x: number): ReviewFeature {
  return {
    type: "Feature",
    id,
    feature_type: "unit",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0]
        ]
      ]
    },
    properties: { name: { en: id }, level_id: levelId }
  };
}

const FEATURES = [square("a", "level-1", 0), square("b", "level-1", 10), square("c", "level-2", 40)];

function panel(props: Partial<React.ComponentProps<typeof MapPanel>> = {}) {
  return (
    <MapPanel
      features={FEATURES}
      selectedFeatureIds={[]}
      layerVisibility={{}}
      validationIssues={[]}
      overlayVisibility={{}}
      visibleLevelIds={null}
      showBasemap
      onSelectFeature={() => {}}
      {...props}
    />
  );
}

beforeEach(() => {
  fitBounds.mockClear();
});

test("the dataset is framed once on open", () => {
  // The only automatic framing left, so it has to keep working: without it the
  // map would open on its hardcoded initial view and never find the data.
  render(panel());
  expect(fitBounds).toHaveBeenCalledTimes(1);
  expect(fitBounds.mock.calls[0][0]).toEqual([
    [0, 0],
    [41, 1]
  ]);
});

test("the opening frame ignores layers that are switched off", () => {
  // Venue, footprint and level are hidden by default and are the big shapes;
  // framing them left the units you actually work with small and off-centre.
  const venue = { ...square("venue-1", "level-1", 900), feature_type: "venue" };
  render(panel({ features: [...FEATURES, venue], layerVisibility: { venue: false } }));

  expect(fitBounds.mock.calls[0][0]).toEqual([
    [0, 0],
    [41, 1]
  ]);
});

test("selecting a feature frames that feature", () => {
  const { rerender } = render(panel());
  fitBounds.mockClear();

  rerender(panel({ selectedFeatureIds: ["b"] }));

  expect(fitBounds).toHaveBeenCalledTimes(1);
  const [bounds] = fitBounds.mock.calls[0];
  expect(bounds).toEqual([
    [10, 0],
    [11, 1]
  ]);
});

test("a feature hidden by the floor filter is still framed when selected", () => {
  // The selection used to be read off the visible set, so picking a feature on
  // another floor produced an empty one and the camera framed the whole floor.
  const { rerender } = render(panel({ visibleLevelIds: ["level-1"] }));
  fitBounds.mockClear();

  rerender(panel({ visibleLevelIds: ["level-1"], selectedFeatureIds: ["c"] }));

  expect(fitBounds).toHaveBeenCalledTimes(1);
  expect(fitBounds.mock.calls[0][0]).toEqual([
    [40, 0],
    [41, 1]
  ]);
});

test("changing floor leaves the camera alone", () => {
  const { rerender } = render(panel({ visibleLevelIds: ["level-1"] }));
  fitBounds.mockClear();

  rerender(panel({ visibleLevelIds: ["level-2"] }));

  expect(fitBounds).not.toHaveBeenCalled();
});

test("hiding a layer leaves the camera alone", () => {
  const { rerender } = render(panel());
  fitBounds.mockClear();

  rerender(panel({ layerVisibility: { unit: false } }));

  expect(fitBounds).not.toHaveBeenCalled();
});

test("re-rendering with the same selection does not re-frame", () => {
  const { rerender } = render(panel({ selectedFeatureIds: ["a"] }));
  fitBounds.mockClear();

  rerender(panel({ selectedFeatureIds: ["a"], features: [...FEATURES] }));

  expect(fitBounds).not.toHaveBeenCalled();
});
