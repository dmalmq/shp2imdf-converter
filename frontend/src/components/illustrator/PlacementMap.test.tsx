import React from "react";
import { render, screen } from "@testing-library/react";

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
      floors={LAYERS}
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
      pickingControlPoint={false}
      onPickMap={() => {}}
    />
  );
  // The deleted dropdown announced "(unlinked)"; the pill must keep that
  // signal in the accessible name, not just in a tooltip or a dot.
  expect(screen.getByRole("button", { name: /unlinked/i })).toBeInTheDocument();
  // Linked pills keep their plain label as the name — no aria-label noise.
  expect(screen.getByRole("button", { name: "1F" })).toBeInTheDocument();
});
