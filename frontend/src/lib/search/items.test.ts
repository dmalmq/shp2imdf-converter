import { describe, expect, it } from "vitest";

import type { ProjectSummary, ValidationIssue, ValidationResponse } from "../../api/client";
import { buildCheckView } from "../check";
import { buildItems, MAX_ISSUE_ITEMS, stationFloorItems } from "./items";
import type { CheckSource } from "./source";

const project = (id: string, name: string): ProjectSummary => ({
  id,
  flow: "shapefiles",
  name,
  import_profile: "standard",
  stage: "check",
  updated_at: null,
  last_opened: "2026-09-25T00:00:00Z",
  blockers: 1,
  can_wait: 0,
  delivered_at: null,
  changed_since_delivery: false,
  expires_at: "2026-10-25T00:00:00Z"
});

const PROJECTS = [project("tokyo", "東京駅"), project("shinjuku", "新宿駅")];

describe("buildItems", () => {
  it("indexes at most MAX_ISSUE_ITEMS issues, must fix first", () => {
    const issue = (n: number, severity: "error" | "warning"): ValidationIssue => ({
      check: severity === "error" ? "unit_missing_level_id_error" : "overlapping_units",
      feature_id: `f${n}`,
      related_feature_id: null,
      message: "",
      severity,
      auto_fixable: false,
      fix_description: null,
      overlap_geometry: null,
      snap_candidates: []
    });
    const validation = {
      errors: Array.from({ length: 50 }, (_, n) => issue(n, "error")),
      warnings: Array.from({ length: 500 }, (_, n) => issue(n + 50, "warning")),
      passed: [],
      summary: { error_count: 50, warning_count: 500 }
    } as unknown as ValidationResponse;
    const check = {
      snapshot: {
        sessionId: "s",
        contentRev: 1,
        features: [],
        validation,
        view: buildCheckView(validation, [], []),
        floors: [],
        language: "en"
      }
    } as unknown as CheckSource;
    const items = buildItems({
      projects: [],
      sessionId: "s",
      station: null,
      files: [],
      floors: [],
      check,
      uiLanguage: "en",
      setLanguage: () => undefined,
      floorPath: () => null,
      deliverPath: null,
      bringInPath: "/p/new"
    });
    const issues = items.all.filter((item) => item.kind === "issue");
    expect(issues).toHaveLength(MAX_ISSUE_ITEMS);
    expect(issues[0].detail.en).toContain("blocks delivery");
    expect(issues[49].detail.en).toContain("blocks delivery");
    expect(issues[50].detail.en).toContain("can wait");
  });
});

describe("stationFloorItems", () => {
  it.each([["東京駅 1F"], ["東京駅1階"], ["東京 １Ｆ"]])("opens Check at 1F for %s", (query) => {
    expect(stationFloorItems(query, PROJECTS, null)).toMatchObject([
      { kind: "floor", label: { en: "東京駅 · 1F" }, run: { kind: "navigate", to: "/p/tokyo/check?floor=1F" } }
    ]);
  });

  it("leaves the loaded project to its own floors, and needs a floor word", () => {
    expect(stationFloorItems("東京駅 1F", PROJECTS, "tokyo")).toEqual([]);
    expect(stationFloorItems("東京駅", PROJECTS, null)).toEqual([]);
  });

  it("reads 地下1階 as B1F", () => {
    expect(stationFloorItems("新宿駅 地下1階", PROJECTS, null)[0].run).toEqual({
      kind: "navigate",
      to: "/p/shinjuku/check?floor=B1F"
    });
  });
});
