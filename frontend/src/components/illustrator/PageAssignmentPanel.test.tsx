import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { PageAssignmentPanel, buildFloors, duplicateLabels } from "./PageAssignmentPanel";
import type { IllustratorPagePreview } from "../../api/client";
import type { PartitionFloor } from "../../lib/svgPreview";


function page(index: number, overrides: Partial<IllustratorPagePreview> = {}): IllustratorPagePreview {
  return {
    index,
    bounds: [0, 0, 200, 200],
    width_pt: 200,
    height_pt: 200,
    feature_count: 1,
    preview_feature_count: 1,
    ...overrides
  };
}

function feature(pageNo: number) {
  return {
    type: "Feature" as const,
    properties: { page: pageNo, ai_layer: "Fill Layer", role: "polygon" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0]
        ]
      ]
    }
  };
}

function renderPanel(pages: IllustratorPagePreview[], onAssigned = () => {}) {
  const preview = {
    type: "FeatureCollection" as const,
    features: pages.map((p) => feature(p.index))
  };
  render(
    <PageAssignmentPanel
      preview={preview}
      pages={pages}
      layerSummaries={[{ table: "Fill Layer", ai_layer: "Fill Layer", role: "polygon", feature_count: 1 }]}
      onAssigned={onAssigned}
      onSkip={() => {}}
    />
  );
}


test("buildFloors names pages 1F, 2F in page order", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "2F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([
    { label: "1F", box: null, pages: [1], layerNames: null },
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("buildFloors merges pages that share a label into one floor", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "1F", excluded: false },
      { index: 3, label: "2F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([
    { label: "1F", box: null, pages: [1, 2], layerNames: null },
    { label: "2F", box: null, pages: [3], layerNames: null }
  ]);
});

test("buildFloors drops excluded pages and blank labels", () => {
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: true },
      { index: 2, label: "   ", excluded: false },
      { index: 3, label: "3F", excluded: false }
    ],
    new Map()
  );
  expect(floors).toEqual([{ label: "3F", box: null, pages: [3], layerNames: null }]);
});

test("buildFloors uses a page's boxes instead of a whole-page floor", () => {
  const boxes: PartitionFloor[] = [
    { label: "1F-north", box: [0, 0, 100, 200], pages: [1], layerNames: null },
    { label: "1F-south", box: [100, 0, 200, 200], pages: [1], layerNames: null }
  ];
  const floors = buildFloors(
    [
      { index: 1, label: "1F", excluded: false },
      { index: 2, label: "2F", excluded: false }
    ],
    new Map([[1, boxes]])
  );
  expect(floors).toEqual([
    ...boxes,
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("duplicateLabels finds a collision between a box floor and a page floor", () => {
  expect(
    duplicateLabels([
      { label: "2F", box: [0, 0, 10, 10], pages: [1], layerNames: null },
      { label: "2F", box: null, pages: [2], layerNames: null }
    ])
  ).toEqual(["2F"]);
  expect(duplicateLabels([{ label: "1F", box: null, pages: [1], layerNames: null }])).toEqual([]);
});

test("a page with no features defaults to excluded", () => {
  renderPanel([page(1), page(2, { feature_count: 0, preview_feature_count: 0 })]);
  const toggles = screen.getAllByRole("checkbox");
  expect(toggles[0]).not.toBeChecked();
  expect(toggles[1]).toBeChecked();
});

test("the size warning appears only when sheet sizes differ", () => {
  renderPanel([page(1), page(2)]);
  expect(screen.queryByTestId("page-size-warning")).toBeNull();
});

test("differing sheet sizes warn that floors may need individual positioning", () => {
  renderPanel([page(1), page(2, { width_pt: 400, height_pt: 400 })]);
  expect(screen.getByTestId("page-size-warning")).toBeInTheDocument();
});

test("two pages named the same show a merge hint", () => {
  renderPanel([page(1), page(2)]);
  const inputs = screen.getAllByLabelText(/floor name/i);
  fireEvent.change(inputs[1], { target: { value: "1F" } });
  expect(screen.getAllByText("2 pages → 1F").length).toBeGreaterThan(0);
});

test("Done assigning emits one floor per page", () => {
  const calls: PartitionFloor[][] = [];
  renderPanel([page(1), page(2)], (floors) => calls.push(floors));
  fireEvent.click(screen.getByRole("button", { name: /done assigning/i }));
  expect(calls[0]).toEqual([
    { label: "1F", box: null, pages: [1], layerNames: null },
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("Done assigning is disabled when every page is excluded", () => {
  renderPanel([page(1, { feature_count: 0 }), page(2, { feature_count: 0 })]);
  expect(screen.getByRole("button", { name: /done assigning/i })).toBeDisabled();
});
