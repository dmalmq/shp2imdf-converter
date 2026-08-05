import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { TransformPanel } from "./TransformPanel";
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

const THREE_LINKED = stateWith(
  [
    { label: "1F", linked: true },
    { label: "2F", linked: true },
    { label: "3F", linked: true }
  ],
  "1F"
);


test("no floor dropdown is rendered, even with three floors", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // Floor switching lives on the map pills; a second control would be redundant.
  // Asserted on the element, not a label query: the current label is not
  // associated with the select, so a label query would pass either way.
  expect(document.querySelector("select")).toBeNull();
});

test("the relink action appears only when the active floor is unlinked", () => {
  const { rerender } = render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByRole("button", { name: /relink/i })).toBeNull();

  const unlinked = stateWith(
    [
      { label: "1F", linked: false },
      { label: "2F", linked: true }
    ],
    "1F"
  );
  rerender(<TransformPanel state={unlinked} dispatch={() => {}} />);
  expect(screen.getByRole("button", { name: /relink/i })).toBeInTheDocument();
});

test("relinking dispatches relinkFloor for the active floor", () => {
  const seen: { type: string; label?: string }[] = [];
  const unlinked = stateWith([{ label: "2F", linked: false }], "2F");
  render(
    <TransformPanel
      state={unlinked}
      dispatch={(action) => seen.push(action as { type: string; label?: string })}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /relink/i }));
  expect(seen).toEqual([{ type: "relinkFloor", label: "2F" }]);
});

test("no relink button while the active floor is linked, even if another floor is unlinked", () => {
  render(
    <TransformPanel
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
  // Relink acts on the ACTIVE floor only; an unlinked sibling changes nothing
  // about it, so the action must stay hidden (and cost 0px).
  expect(screen.queryByRole("button", { name: /relink/i })).toBeNull();
});

test("the interaction hint is one line, with the detail behind a control", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // The short form is always visible.
  expect(screen.getByText(/corners scale/i)).toBeInTheDocument();
  // The keyboard detail is not taking permanent space...
  expect(screen.queryByText(/arrow keys nudge/i)).toBeNull();
  // ...but is reachable.
  fireEvent.click(screen.getByRole("button", { name: /keyboard and mouse help/i }));
  expect(screen.getByText(/arrow keys nudge/i)).toBeInTheDocument();
});

test.skip("the scale controls are no longer in this panel", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // Scale moved to the Scale & fit tab panel.
  expect(screen.queryByText(/m per point/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Calibrate" })).toBeNull();
});
