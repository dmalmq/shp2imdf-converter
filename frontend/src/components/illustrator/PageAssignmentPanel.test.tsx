import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { PageAssignmentPanel, buildFloors, duplicateLabels } from "./PageAssignmentPanel";
import { AssignmentPanel } from "./AssignmentPanel";
import type { IllustratorPageAlignment, IllustratorPagePreview } from "../../api/client";
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

function renderPanel(
  pages: IllustratorPagePreview[],
  onAssigned = () => {},
  initialBoxesByPage?: Map<number, PartitionFloor[]>,
  alignment?: IllustratorPageAlignment[]
) {
  const preview = {
    type: "FeatureCollection" as const,
    features: pages.map((p) => feature(p.index))
  };
  render(
    <PageAssignmentPanel
      preview={preview}
      pages={pages}
      layerSummaries={[{ table: "Fill Layer", ai_layer: "Fill Layer", role: "polygon", feature_count: 1 }]}
      initialBoxesByPage={initialBoxesByPage}
      alignment={alignment}
      onAssigned={onAssigned}
      onSkip={() => {}}
    />
  );
}

function alignmentEntry(
  page: number,
  aligned: boolean,
  anchor_page = 1
): IllustratorPageAlignment {
  return {
    page,
    anchor_page,
    offset: aligned ? [8, -3] : [0, 0],
    overlap_iou: aligned ? 0.9 : 0.1,
    aligned
  };
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

test("sub-point MediaBox noise does not trigger the size warning", () => {
  renderPanel([page(1, { width_pt: 1190.9999, height_pt: 841.9998 }), page(2, { width_pt: 1191.0001, height_pt: 842.0002 })]);
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

test("buildFloors emits a whole-page floor again for a page whose boxes were removed", () => {
  const cards = [
    { index: 1, label: "1F", excluded: false },
    { index: 2, label: "2F", excluded: false }
  ];
  const boxes: PartitionFloor[] = [
    { label: "1F-north", box: [0, 0, 100, 200], pages: [1], layerNames: null }
  ];
  // While the page is split, its boxes stand in for the whole-page floor.
  expect(buildFloors(cards, new Map([[1, boxes]]))).toEqual([
    ...boxes,
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
  // After Remove boxes deletes the map entry, the page is a whole-page floor again.
  expect(buildFloors(cards, new Map())).toEqual([
    { label: "1F", box: null, pages: [1], layerNames: null },
    { label: "2F", box: null, pages: [2], layerNames: null }
  ]);
});

test("a page with boxes shows a Remove boxes control that re-enables the floor-name input", () => {
  const boxes: PartitionFloor[] = [
    { label: "1F-north", box: [0, 0, 100, 200], pages: [1], layerNames: null }
  ];
  renderPanel([page(1), page(2)], () => {}, new Map([[1, boxes]]));
  expect(screen.getByLabelText("Floor name for page 1")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /remove boxes/i }));
  expect(screen.getByLabelText("Floor name for page 1")).toBeEnabled();
  expect(screen.queryByRole("button", { name: /remove boxes/i })).toBeNull();
  // Both cards are on the normal whole-page path again.
  expect(screen.getAllByRole("button", { name: /split this page/i })).toHaveLength(2);
});

test("AssignmentPanel seeds drafts from initialDrafts, and starts blank without it", () => {
  const preview = {
    type: "FeatureCollection" as const,
    features: [feature(1)]
  };
  const layerSummaries = [
    { table: "Fill Layer", ai_layer: "Fill Layer", role: "polygon", feature_count: 1 }
  ];
  const seeded: PartitionFloor[] = [
    { label: "1F-north", box: [0, 0, 100, 200], pages: [1], layerNames: null },
    { label: "1F-south", box: [0, 0, 100, 200], pages: [1], layerNames: null }
  ];
  const { unmount } = render(
    <AssignmentPanel
      preview={preview}
      artworkBounds={[0, 0, 200, 200]}
      layerSummaries={layerSummaries}
      initialDrafts={seeded}
      onAssigned={() => {}}
      onSkip={() => {}}
    />
  );
  expect(screen.getByDisplayValue("1F-north")).toBeInTheDocument();
  expect(screen.getByDisplayValue("1F-south")).toBeInTheDocument();
  // The feature-count row is present; the polygon's centroid (5,5) lies in the
  // first box, so that row reports the single preview feature.
  expect(screen.getByText("features: 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /done assigning/i })).toBeEnabled();
  unmount();

  render(
    <AssignmentPanel
      preview={preview}
      artworkBounds={[0, 0, 200, 200]}
      layerSummaries={layerSummaries}
      onAssigned={() => {}}
      onSkip={() => {}}
    />
  );
  expect(screen.queryByDisplayValue("1F-north")).toBeNull();
  expect(screen.getByRole("button", { name: /done assigning/i })).toBeDisabled();
});

test("alignment note lists moved pages and warning lists failed pages", () => {
  renderPanel(
    [page(1), page(2), page(3), page(4), page(5)],
    () => {},
    undefined,
    [
      alignmentEntry(2, true),
      alignmentEntry(3, true),
      alignmentEntry(4, false),
      alignmentEntry(5, false)
    ]
  );
  expect(screen.getByTestId("page-alignment-note")).toHaveTextContent(
    "Pages 2, 3 were aligned to page 1 automatically."
  );
  expect(screen.getByTestId("page-alignment-warning")).toHaveTextContent(
    "Pages 4, 5 did not match page 1; align those floors yourself."
  );
});

test("a single moved page uses singular wording", () => {
  renderPanel([page(1), page(2)], () => {}, undefined, [alignmentEntry(2, true)]);
  expect(screen.getByTestId("page-alignment-note")).toHaveTextContent(
    "Page 2 was aligned to page 1 automatically."
  );
  expect(screen.queryByTestId("page-alignment-warning")).toBeNull();
});

test("omitted alignment renders neither note nor warning", () => {
  renderPanel([page(1), page(2)]);
  expect(screen.queryByTestId("page-alignment-note")).toBeNull();
  expect(screen.queryByTestId("page-alignment-warning")).toBeNull();
});
