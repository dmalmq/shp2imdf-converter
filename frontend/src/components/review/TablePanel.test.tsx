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


test("level column names the referenced level, not a fragment of its id", () => {
  const level: ReviewFeature = {
    type: "Feature",
    id: "9d22cff9-0000-0000-0000-000000000000",
    feature_type: "level",
    geometry: null,
    properties: { name: { ja: "1F" }, short_name: { ja: "1F" }, ordinal: 0 }
  };
  const unit = { ...makeFeature("u1"), properties: { name: "Unit A", level_id: level.id } };
  const orphan = { ...makeFeature("u2"), properties: { name: "Unit B", level_id: "deadbeef-1111" } };

  render(<TablePanel features={[level, unit, orphan]} selectedFeatureIds={[]} onSelectFeature={() => {}} />);

  const levelCell = (name: string) => screen.getByText(name).closest("tr")!.querySelectorAll("td")[5].textContent;
  expect(levelCell("Unit A")).toBe("1F");
  expect(levelCell("Unit B")).toBe("deadbeef");
  expect(screen.getAllByText("1F")).toHaveLength(2);
  expect(screen.getByText("9d22cff9").closest("tr")!.querySelectorAll("td")[5].textContent).toBe("-");
});


test("level column resolves levels the active filter hid from the rows", () => {
  const unit = { ...makeFeature("u1"), properties: { name: "Unit A", level_id: "lvl-2" } };

  render(
    <TablePanel
      features={[unit]}
      levelOptions={[{ id: "lvl-2", label: "2F" }]}
      selectedFeatureIds={[]}
      onSelectFeature={() => {}}
    />
  );

  expect(screen.getByText("Unit A").closest("tr")!.querySelectorAll("td")[5].textContent).toBe("2F");
});


test("issue column shows the first validation message for the row", () => {
  const broken = { ...makeFeature("u1"), properties: { name: "Unit A", status: "error" } };
  const clean = { ...makeFeature("u2"), properties: { name: "Unit B" } };
  const issues = new Map([["u1", [{ message: "Overlaps unit u9" }, { message: "Missing name" }]]]);

  render(
    <TablePanel features={[broken, clean]} issuesByFeature={issues} selectedFeatureIds={[]} onSelectFeature={() => {}} />
  );

  const issueCell = (name: string) => screen.getByText(name).closest("tr")!.querySelectorAll("td")[7].textContent;
  expect(issueCell("Unit A")).toBe("Overlaps unit u9");
  expect(issueCell("Unit B")).toBe("-");
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
