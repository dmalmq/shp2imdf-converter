import { describe, expect, it } from "vitest";

import type { ProjectSummary } from "../../api/client";
import { stationFloorItems } from "./items";

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
