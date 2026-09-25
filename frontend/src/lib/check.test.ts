import type { ValidationIssue, ValidationResponse } from "../api/client";
import type { FloorGroup } from "../components/review/floorGroups";
import type { ReviewFeature } from "../components/review/types";
import { areaSquareMetres, buildCheckView, locateIssue, refocus, trimRemoves, undoable, type DoneFix } from "./check";
import { issueCopy } from "./checkCopy";

const issue = (check: string, severity: "error" | "warning", feature_id: string, related_feature_id?: string): ValidationIssue => ({
  check,
  severity,
  feature_id,
  related_feature_id,
  message: "",
  auto_fixable: false
});

const validation = (errors: ValidationIssue[], warnings: ValidationIssue[]): ValidationResponse => ({
  errors,
  warnings,
  passed: [],
  summary: {
    total_features: 0,
    by_type: {},
    error_count: errors.length,
    warning_count: warnings.length,
    auto_fixable_count: 0,
    checks_passed: 0,
    checks_failed: 0,
    unspecified_count: 0,
    overlap_count: 0,
    opening_issues_count: 0
  }
});

const unit = (id: string, level: string): ReviewFeature => ({
  type: "Feature",
  id,
  feature_type: "unit",
  geometry: null,
  properties: { level_id: level }
});

const floors: FloorGroup[] = [
  { id: "B1F", label: "B1F", levelIds: ["l-b1"] },
  { id: "1F", label: "1F", levelIds: ["l-1", "l-1-out"] }
];

test("errors must be fixed, warnings can wait, and an overlap counts once per pair", () => {
  const view = buildCheckView(
    validation(
      [issue("unit_missing_category_error", "error", "c", undefined), issue("unit_missing_category_error", "error", "a")],
      [issue("overlapping_units", "warning", "a", "b"), issue("overlapping_units", "warning", "b", "a")]
    ),
    [unit("a", "l-1-out"), unit("b", "l-1"), unit("c", "l-b1")],
    floors
  );

  expect(view.mustFix.map((group) => [group.check, group.issues.length, group.floors])).toEqual([
    ["unit_missing_category_error", 2, ["B1F", "1F"]]
  ]);
  expect(view.canWait.map((group) => group.issues.length)).toEqual([1]);
  expect([view.blockers, view.warnings]).toEqual([2, 2]);
  expect(locateIssue(view, issue("overlapping_units", "warning", "b", "a"))).toEqual({ key: "wait:overlapping_units", index: 0 });
});

test("after a fix the popover stays on the check, or closes when none are left", () => {
  const view = buildCheckView(validation([issue("x", "error", "a")], []), [], []);
  expect(refocus(view, { key: "must:x", index: 3 })).toEqual({ key: "must:x", index: 0 });
  expect(refocus(view, { key: "wait:y", index: 0 })).toBeNull();
});

test("a fix can be undone only while no later fix touched the same features", () => {
  const undo = (remove_ids: string[], ids: string[]) => ({
    remove_ids,
    features: ids.map((id) => ({ id })),
    fingerprints: {},
    digest: ""
  });
  const first: DoneFix = { id: 1, label: { en: "", ja: "" }, undo: undo([], ["a"]) };
  const later: DoneFix = { id: 2, label: { en: "", ja: "" }, undo: undo(["a"], []) };
  const unrelated: DoneFix = { id: 2, label: { en: "", ja: "" }, undo: undo([], ["b"]) };
  expect(undoable([first, later], first)).toBe(false);
  expect(undoable([first, later], later)).toBe(true);
  expect(undoable([first, unrelated], first)).toBe(true);
  expect(undoable([{ ...first, stale: true }], { ...first, stale: true })).toBe(false);
});

test("keeping one of two spaces removes the other when it lies wholly inside the overlap", () => {
  const side = 10 / 111_320;
  const box = (x: number, width: number) => ({
    type: "Polygon",
    coordinates: [[[x, 0], [x + width, 0], [x + width, side], [x, side], [x, 0]]]
  });
  const inner: ReviewFeature = { type: "Feature", id: "b", feature_type: "unit", geometry: box(139, side), properties: {} };
  expect(trimRemoves(box(139, side), inner)).toBe(true);
  expect(trimRemoves(box(139, side / 2), inner)).toBe(false);
});

test("overlap area is in square metres", () => {
  const side = 10 / 111_320;
  const square = { type: "Polygon", coordinates: [[[139, 0], [139 + side, 0], [139 + side, side], [139, side], [139, 0]]] };
  expect(areaSquareMetres(square)).toBeCloseTo(100, 0);
});

test("family checks are named after their feature type in both languages", () => {
  expect(issueCopy("opening_missing_category_error").title).toEqual({ en: "Door has no category", ja: "カテゴリのない開口部" });
  expect(issueCopy("footprint_must_be_polygon").title.en).toBe("Footprint has the wrong kind of shape");
  expect(issueCopy("something_new").title.en).toBe("Something to look at");
});
