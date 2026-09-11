import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { TransformPanel } from "./TransformPanel";
import {
  DEFAULT_METRES_PER_POINT,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";


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

const THREE_LINKED = stateWith(
  [
    { label: "1F", linked: true },
    { label: "2F", linked: true },
    { label: "3F", linked: true }
  ],
  "1F"
);


test("no floor dropdown is rendered, even with three floors", () => {
  render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={() => {}} />);
  expect(document.querySelector("select")).toBeNull();
});

test("the relink action appears only when the active floor is unlinked", () => {
  const { rerender } = render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByRole("button", { name: /relink/i })).toBeNull();

  const unlinked = stateWith(
    [
      { label: "1F", linked: false },
      { label: "2F", linked: true }
    ],
    "1F"
  );
  rerender(<TransformPanel mode="group" state={unlinked} dispatch={() => {}} />);
  expect(screen.getByRole("button", { name: /relink/i })).toBeInTheDocument();
});

test("relinking dispatches relinkFloor for the active floor", () => {
  const seen: { type: string; label?: string }[] = [];
  const unlinked = stateWith([{ label: "2F", linked: false }], "2F");
  render(
    <TransformPanel mode="group"
      state={unlinked}
      dispatch={(action) => seen.push(action as { type: string; label?: string })}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /relink/i }));
  expect(seen).toEqual([{ type: "relinkFloor", label: "2F" }]);
});

test("no relink button while the active floor is linked, even if another floor is unlinked", () => {
  render(
    <TransformPanel mode="group"
      state={stateWith(
        [
          { label: "1F", linked: true },
          { label: "2F", linked: false }
        ],
        "1F"
      )}
      dispatch={() => {}}
    />
  );
  expect(screen.queryByRole("button", { name: /relink/i })).toBeNull();
});

test("both interaction hints sit behind the help control", () => {
  render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByText(/corners scale/i)).toBeNull();
  expect(screen.queryByText(/arrow keys nudge/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /keyboard and mouse help/i }));
  expect(screen.getByText(/corners scale/i)).toBeInTheDocument();
  expect(screen.getByText(/arrow keys nudge/i)).toBeInTheDocument();
});

test("the scale controls are no longer in this panel", () => {
  render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByText(/m per point/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Calibrate" })).toBeNull();
});

test("group mode edits the shared frame from the rotation input", () => {
  const seen: PlacementAction[] = [];
  render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={(action) => seen.push(action)} />);
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "45" } });
  expect(seen).toEqual([{ type: "rotateFrame", rotationDeg: 45 }]);
});

test("individual mode edits the active floor from the rotation input", () => {
  const seen: PlacementAction[] = [];
  render(
    <TransformPanel mode="individual" state={THREE_LINKED} dispatch={(action) => seen.push(action)} />
  );
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "45" } });
  expect(seen).toEqual([{ type: "rotateFloor", label: "1F", rotationDeg: 45 }]);
});

test("the (this floor) suffix follows what the controls edit, not just linking", () => {
  const { rerender } = render(<TransformPanel mode="group" state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByText(/this floor/)).toBeNull();
  rerender(<TransformPanel mode="individual" state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.getByText(/this floor/)).toBeInTheDocument();
});
