import {
  DEFAULT_ARTWORK_VIEW,
  floorPaint,
  toggleOthersHidden,
  toggleTransparent,
  type ArtworkView
} from "./artworkView";

const TINT = "#3b82f6";
const ALL_VIEWS: ArtworkView[] = [
  { active: "solid", others: "ghost" },
  { active: "solid", others: "hidden" },
  { active: "transparent", others: "ghost" },
  { active: "transparent", others: "hidden" }
];

test("show is the default: solid active floor over ghosts", () => {
  expect(DEFAULT_ARTWORK_VIEW).toEqual({ active: "solid", others: "ghost" });
});

test("the default active paint is today's paint: 0.45 fill, 1.0 line, artwork colours with tint fallback", () => {
  const p = floorPaint("active", DEFAULT_ARTWORK_VIEW, TINT);
  expect(p.layout.visibility).toBe("visible");
  expect(p.fill).toEqual({
    "fill-color": ["coalesce", ["get", "fill_color"], TINT],
    "fill-opacity": 0.45
  });
  expect(p.line).toEqual({
    "line-color": ["coalesce", ["get", "stroke_color"], ["get", "fill_color"], TINT],
    "line-width": 1,
    "line-opacity": 1
  });
});

test("a transparent active floor drops its fill entirely but keeps its lines", () => {
  const p = floorPaint("active", { active: "transparent", others: "ghost" }, TINT);
  const ghost = floorPaint("other", DEFAULT_ARTWORK_VIEW, TINT);
  expect(p.fill["fill-opacity"]).toBe(0);
  expect(p.fill["fill-opacity"]).toBeLessThan(ghost.fill["fill-opacity"] as number);
  expect(p.line["line-opacity"]).toBe(0.8);
  expect(p.line["line-width"]).toBe(1);
});

test("the active floor is visible in every view — the gizmo hit-tests those layers", () => {
  for (const view of ALL_VIEWS) {
    expect(floorPaint("active", view, TINT).layout.visibility).toBe("visible");
  }
});

test("solid vs transparent differ only in fill-opacity and line-opacity", () => {
  const solid = floorPaint("active", { active: "solid", others: "ghost" }, TINT);
  const clear = floorPaint("active", { active: "transparent", others: "ghost" }, TINT);
  expect(clear.layout).toEqual(solid.layout);
  expect(clear.fill["fill-color"]).toEqual(solid.fill["fill-color"]);
  expect(clear.line["line-color"]).toEqual(solid.line["line-color"]);
  expect(clear.line["line-width"]).toEqual(solid.line["line-width"]);
  expect({
    ...clear,
    fill: { ...clear.fill, "fill-opacity": solid.fill["fill-opacity"] },
    line: { ...clear.line, "line-opacity": solid.line["line-opacity"] }
  }).toEqual(solid);
  expect(clear.fill["fill-opacity"]).toBe(0);
  expect(clear.line["line-opacity"]).toBe(0.8);
});

test("the active floor's paint ignores what happens to the others", () => {
  expect(floorPaint("active", { active: "solid", others: "hidden" }, TINT)).toEqual(
    floorPaint("active", { active: "solid", others: "ghost" }, TINT)
  );
});

test("ghost paint is the floor tint at 0.06 / 0.35, never artwork colours", () => {
  const p = floorPaint("other", DEFAULT_ARTWORK_VIEW, TINT);
  expect(p.layout.visibility).toBe("visible");
  expect(p.fill).toEqual({ "fill-color": TINT, "fill-opacity": 0.06 });
  expect(p.line).toEqual({ "line-color": TINT, "line-width": 0.5, "line-opacity": 0.35 });
});

test("hidden others are layout-only: visibility none over unchanged ghost paint", () => {
  const ghost = floorPaint("other", { active: "solid", others: "ghost" }, TINT);
  const hidden = floorPaint("other", { active: "solid", others: "hidden" }, TINT);
  expect(hidden.layout.visibility).toBe("none");
  expect(hidden.fill).toEqual(ghost.fill);
  expect(hidden.line).toEqual(ghost.line);
});

test("other floors' paint ignores the active floor's appearance", () => {
  expect(floorPaint("other", { active: "transparent", others: "ghost" }, TINT)).toEqual(
    floorPaint("other", { active: "solid", others: "ghost" }, TINT)
  );
});

test("each toggle flips its own field only and is its own inverse", () => {
  for (const view of ALL_VIEWS) {
    expect(toggleTransparent(view).others).toBe(view.others);
    expect(toggleTransparent(view).active).not.toBe(view.active);
    expect(toggleTransparent(toggleTransparent(view))).toEqual(view);
    expect(toggleOthersHidden(view).active).toBe(view.active);
    expect(toggleOthersHidden(view).others).not.toBe(view.others);
    expect(toggleOthersHidden(toggleOthersHidden(view))).toEqual(view);
  }
});

test("equal inputs give deep-equal paint", () => {
  for (const view of ALL_VIEWS) {
    for (const role of ["active", "other"] as const) {
      expect(floorPaint(role, view, TINT)).toEqual(floorPaint(role, view, TINT));
    }
  }
});
