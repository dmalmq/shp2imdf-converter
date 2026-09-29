import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import type { PlacementState } from "../../hooks/useIllustratorPlacement";
import type { FloorStatus } from "../../lib/floorStatus";
import { PlacementTodo } from "./PlacementTodo";

const floor = (label: string, extra: Partial<PlacementState["floors"][number]> = {}) => ({
  label,
  linked: true,
  pinned: false,
  artworkAnchor: [100, 80] as [number, number],
  mapAnchor: [139.7671, 35.6812] as [number, number],
  controlPoints: [],
  artworkBounds: [0, 0, 200, 160] as [number, number, number, number],
  ...extra
});

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [
    floor("1F"),
    floor("2F"),
    floor("3F", { linked: false, artworkMatch: true, rotationDeg: 0, metresPerPoint: 0.176389 }),
    floor("4F")
  ],
  activeFloorLabel: "3F",
  scaleLocked: true
};

test("the to-do counts aligned floors, puts the active floor first and groups linked floors", () => {
  const onAlign = vi.fn();
  render(
    <PlacementTodo
      state={STATE}
      dispatch={vi.fn()}
      references={{ preloaded: true, uploads: [], removed: [], pin: null }}
      statuses={new Map<string, FloorStatus>([["4F", { kind: "aligned", basis: { kind: "reference", reference: { layer: "Station_pg", preloaded: true, uploads: [], pin: null } } }]])}
      onAlign={onAlign}
      artworkBounds={[0, 0, 200, 160]}
      notes={["The pages are not all the same size."]}
    />
  );
  expect(screen.getByTestId("todo-summary")).toHaveTextContent("1 of 4 floors aligned · 3 left · 3F is next");
  const cards = document.querySelectorAll("[data-todo]");
  expect([...cards].map((card) => card.getAttribute("data-todo"))).toEqual(["3F", "1F"]);
  expect(cards[0]).toHaveTextContent("Align 3F to 2F");
  expect(cards[1]).toHaveTextContent("2F is linked to it, so one group fit aligns it too.");
  expect(screen.getByText("Done · 1")).toBeInTheDocument();
  expect(screen.getByText("Can wait · 1 note")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Align 3F to 2F" })[0]);
  expect(onAlign).toHaveBeenCalledWith("3F");
});
