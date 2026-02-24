import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { TablePanel } from "./TablePanel";
import type { ReviewFeature } from "./types";


function makeFeature(id: string): ReviewFeature {
  return {
    type: "Feature",
    id,
    feature_type: "unit",
    geometry: null,
    properties: {
      name: id,
      category: "room",
      status: "mapped"
    }
  };
}


function renderWithSelection(features: ReviewFeature[]) {
  function Harness() {
    const [selected, setSelected] = useState<string[]>([]);
    const onSelectFeature = (id: string, multi = false) => {
      setSelected((current) => {
        if (multi) {
          if (current.includes(id)) {
            return current.filter((item) => item !== id);
          }
          return [...current, id];
        }
        if (current.length === 1 && current[0] === id) {
          return [];
        }
        return [id];
      });
    };

    return (
      <>
        <div data-testid="selected">{selected.join(",")}</div>
        <TablePanel features={features} selectedFeatureIds={selected} onSelectFeature={onSelectFeature} />
      </>
    );
  }

  return render(<Harness />);
}


test("header checkbox toggles all visible rows", () => {
  const features = [makeFeature("f1"), makeFeature("f2"), makeFeature("f3")];
  renderWithSelection(features);

  const checkboxes = screen.getAllByRole("checkbox");
  let selectAll = checkboxes[0];

  fireEvent.click(selectAll);
  expect(screen.getByTestId("selected").textContent).toBe("f1,f2,f3");

  selectAll = screen.getAllByRole("checkbox")[0];
  fireEvent.click(selectAll);
  expect(screen.getByTestId("selected").textContent).toBe("");
});


test("shift-click selects checkbox ranges", () => {
  const features = [makeFeature("f1"), makeFeature("f2"), makeFeature("f3"), makeFeature("f4")];
  renderWithSelection(features);

  const checkboxes = screen.getAllByRole("checkbox");
  const firstRow = checkboxes[1];

  fireEvent.click(firstRow);
  const thirdRow = screen.getAllByRole("checkbox")[3];
  fireEvent.click(thirdRow, { shiftKey: true });

  expect(screen.getByTestId("selected").textContent).toBe("f1,f2,f3");
});
