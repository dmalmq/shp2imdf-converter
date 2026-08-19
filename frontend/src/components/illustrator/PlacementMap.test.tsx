import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { PlacementMap, type FloorLayer } from "./PlacementMap";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";


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


test("an unlinked floor carries the unlinked marker in its accessible name", () => {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // The deleted dropdown announced "(unlinked)"; the pill must keep that
  // signal in the accessible name, not just in a tooltip or a dot.
  expect(screen.getByRole("button", { name: /unlinked/i })).toBeInTheDocument();
  // Linked pills keep their plain label as the name — no aria-label noise.
  expect(screen.getByRole("button", { name: "1F" })).toBeInTheDocument();
});

test("the pill for the active floor announces its pressed state", () => {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // The deleted dropdown announced its current value; the pills are the only
  // floor control now, so the active one must be exposed as a state, not as
  // a purely visual colour change. Asserted via the accessible state, not an
  // attribute string.
  expect(screen.getByRole("button", { name: "1F", pressed: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /unlinked/i, pressed: false })).toBeInTheDocument();
});

const ONE_LAYER: FloorLayer[] = [
  { label: "1F", features: [], bounds: [0, 0, 1, 1], color: "#3b82f6" }
];

function renderMap(layers: FloorLayer[], floors: { label: string; linked: boolean }[]) {
  render(
    <PlacementMap
      mode="group"
      onModeChange={() => {}}
      floors={layers}
      state={stateWith(floors, floors[0].label)}
      dispatch={() => {}}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
}


test("the isolate toggle starts off, so ghost floors stay visible by default", () => {
  renderMap(LAYERS, [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ]);
  expect(
    screen.getByRole("button", { name: /only this floor/i, pressed: false })
  ).toBeInTheDocument();
});

test("clicking the isolate toggle flips its pressed state", () => {
  renderMap(LAYERS, [
    { label: "1F", linked: true },
    { label: "2F", linked: true }
  ]);
  fireEvent.click(screen.getByRole("button", { name: /only this floor/i }));
  expect(
    screen.getByRole("button", { name: /only this floor/i, pressed: true })
  ).toBeInTheDocument();
});

test("no isolate toggle with a single floor — there are no ghosts to hide", () => {
  renderMap(ONE_LAYER, [{ label: "1F", linked: true }]);
  expect(screen.queryByRole("button", { name: /only this floor/i })).toBeNull();
});

test("the Group/Individual switch reflects the mode and reports changes", () => {
  const seen: string[] = [];
  render(
    <PlacementMap
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: true }
        ],
        "1F"
      )}
      dispatch={() => {}}
      mode="group"
      onModeChange={(mode) => seen.push(mode)}
      pickStage={null}
      onPickArtwork={() => {}}
      onPickMap={() => {}}
    />
  );
  // Group is the default posture: the building aligns as one first.
  expect(screen.getByRole("button", { name: "Group", pressed: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Individual", pressed: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Individual" }));
  expect(seen).toEqual(["individual"]);
});

test("no mode switch with a single floor — there is nothing to group", () => {
  renderMap(ONE_LAYER, [{ label: "1F", linked: true }]);
  expect(screen.queryByRole("button", { name: "Individual" })).toBeNull();
});
