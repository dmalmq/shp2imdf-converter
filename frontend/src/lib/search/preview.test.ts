import { describe, expect, it } from "vitest";

import type { ValidationResponse } from "../../api/client";
import { buildFloorGroups } from "../../components/review/floorGroups";
import type { ReviewFeature } from "../../components/review/types";
import { buildCheckView } from "../check";
import { parse } from "./parse";
import { preview, type PreviewContext } from "./preview";
import { floorRefs, levelRefs, type CheckSnapshot } from "./source";
import type { Command } from "./types";

const feature = (id: string, featureType: string, properties: Record<string, unknown>): ReviewFeature => ({
  type: "Feature",
  id,
  feature_type: featureType,
  geometry: null,
  properties
});

const FEATURES = [
  feature("l0", "level", { name: { ja: "屋外" }, short_name: { ja: "0F" }, ordinal: 0, outdoor: false }),
  feature("l1", "level", { name: { ja: "1F" }, short_name: { ja: "1F" }, ordinal: 1, outdoor: false }),
  feature("u1", "unit", { level_id: "l0" }),
  feature("u2", "unit", { level_id: "l0" }),
  feature("o1", "opening", { level_id: "l0" }),
  feature("u3", "unit", { level_id: "l1" })
];

const VALIDATION: ValidationResponse = {
  errors: [],
  warnings: [
    { check: "overlapping_units", feature_id: "u1", related_feature_id: "u3", message: "", severity: "warning", auto_fixable: false, fix_description: null, overlap_geometry: null, snap_candidates: [] },
    { check: "overlapping_units", feature_id: "u3", related_feature_id: "u1", message: "", severity: "warning", auto_fixable: false, fix_description: null, overlap_geometry: null, snap_candidates: [] }
  ],
  passed: [],
  summary: {
    total_features: 6,
    by_type: {},
    error_count: 0,
    warning_count: 2,
    auto_fixable_count: 0,
    checks_passed: 0,
    checks_failed: 1,
    unspecified_count: 0,
    overlap_count: 1,
    opening_issues_count: 0
  }
};

function snapshot(validation: ValidationResponse | null = VALIDATION): CheckSnapshot {
  const floors = buildFloorGroups(FEATURES);
  return {
    sessionId: "s",
    contentRev: 12,
    features: FEATURES,
    validation,
    view: buildCheckView(validation, FEATURES, floors),
    floors,
    language: "ja"
  };
}

function context(check: CheckSnapshot | null): PreviewContext {
  return {
    check,
    stagePath: (stage) => (stage === "deliver" ? null : `/p/s/${stage}`),
    stationPath: (id, floor) => `/p/${id}/check${floor ? `?floor=${floor}` : ""}`,
    floorPath: (label) => `/p/s/check?floor=${label}`
  };
}

function commandFor(input: string, check = snapshot()): Command {
  const floors = floorRefs(check.features, check.floors);
  const result = parse(input, { floors, levels: levelRefs(check.features, floors), stations: [{ projectId: "p", name: "東京駅" }] });
  if (result.mode !== "command") throw new Error(result.mode);
  return result.command;
}

describe("preview", () => {
  it("says what assign moves, before and after, and outlines what rides along", () => {
    const result = preview(commandFor("assign 屋外 to 1F outdoor"), context(snapshot()));
    expect(result).toMatchObject({
      kind: "change",
      sentence: { en: "Move the 屋外 level onto floor 1F and mark it as outdoor." },
      consequence: { en: expect.stringContaining("2 spaces and 1 door") },
      rows: [
        { field: { en: "Floor" }, before: "0F", after: "1F" },
        { field: { en: "Ordinal" }, before: "0", after: "1" },
        { field: { en: "Outdoor" }, before: "no", after: "yes" }
      ],
      highlight: ["l0", "u1", "u2", "o1"],
      certainty: "exact",
      basis: 12
    });
  });

  it("has nothing to do when the level is already there", () => {
    expect(preview(commandFor("assign 屋外 to 0F"), context(snapshot())).kind).toBe("nothing-to-do");
  });

  it("will not preview a change without Check", () => {
    const command = commandFor("assign 屋外 to 1F");
    expect(preview(command, context(null))).toMatchObject({ kind: "unavailable" });
  });

  it("counts overlap pairs once, as an upper bound, and needs current checks", () => {
    expect(preview(commandFor("fix overlaps"), context(snapshot()))).toMatchObject({
      kind: "change",
      certainty: "at-most",
      rows: [{ before: "1", after: "0–1" }],
      highlight: ["u1", "u3"]
    });
    expect(preview(commandFor("fix overlaps"), context(snapshot(null)))).toMatchObject({
      kind: "unavailable",
      reason: { en: "Run the checks first" }
    });
  });

  it("goes to a station at a floor, a floor on the map, or a stage", () => {
    expect(preview(commandFor("go 東京駅 1階"), context(null))).toMatchObject({
      kind: "go",
      target: { kind: "route", to: "/p/p/check?floor=1F" }
    });
    expect(preview(commandFor("go 1F"), context(snapshot()))).toMatchObject({ target: { kind: "floor", label: "1F" } });
    expect(preview(commandFor("go deliver"), context(snapshot()))).toMatchObject({ kind: "unavailable" });
  });
});
