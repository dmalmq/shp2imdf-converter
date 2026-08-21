import {
  buildFloorGroups,
  buildLevelOptions,
  defaultFloorId,
  isFeatureOnFloor,
  levelIdsForFloor
} from "./floorGroups";
import type { ReviewFeature } from "./types";

function level(id: string, shortName: string, name: string, ordinal: number): ReviewFeature {
  return {
    type: "Feature",
    id,
    feature_type: "level",
    geometry: { type: "Polygon", coordinates: [] },
    properties: { short_name: { ja: shortName }, name: { ja: name }, ordinal }
  };
}

function unit(id: string, levelId: string): ReviewFeature {
  return {
    type: "Feature",
    id,
    feature_type: "unit",
    geometry: { type: "Polygon", coordinates: [] },
    properties: { level_id: levelId }
  };
}

// 新宿: 1F is split across platform levels, 2F across ラチ内 / ラチ外.
const SHINJUKU: ReviewFeature[] = [
  level("l-1f-a", "1F", "1F 15-16番線", 0),
  level("l-1f-b", "1F", "1F 13-14番線", 0),
  level("l-1f-c", "1F", "1F", 0),
  level("l-2f-in", "2F", "2Fラチ内", 2),
  level("l-2f-out", "2F", "2Fラチ外", 2),
  level("l-b1", "B1", "B1ラチ内", -1)
];

test("levels sharing a floor label collapse into one floor, ordered by ordinal", () => {
  expect(buildFloorGroups(SHINJUKU)).toEqual([
    { id: "B1", label: "B1", levelIds: ["l-b1"] },
    { id: "1F", label: "1F", levelIds: ["l-1f-a", "l-1f-b", "l-1f-c"] },
    { id: "2F", label: "2F", levelIds: ["l-2f-in", "l-2f-out"] }
  ]);
});

test("a floor shows every one of its levels, no floor shows all of them", () => {
  const groups = buildFloorGroups(SHINJUKU);
  expect(levelIdsForFloor(groups, "1F")).toEqual(["l-1f-a", "l-1f-b", "l-1f-c"]);
  expect(levelIdsForFloor(groups, "")).toBeNull();
  // A stale floor id hides features instead of leaking another floor's.
  expect(levelIdsForFloor(groups, "M2")).toEqual([]);
});

test("features on any level of the shown floor are visible", () => {
  const groups = buildFloorGroups(SHINJUKU);
  const shown = new Set(levelIdsForFloor(groups, "1F") ?? []);

  expect(isFeatureOnFloor(unit("u-1", "l-1f-a"), shown)).toBe(true);
  // The bug this replaces: a sibling level of the same floor was hidden.
  expect(isFeatureOnFloor(unit("u-2", "l-1f-c"), shown)).toBe(true);
  expect(isFeatureOnFloor(unit("u-3", "l-2f-in"), shown)).toBe(false);
  expect(isFeatureOnFloor(SHINJUKU[1], shown)).toBe(true);
  expect(isFeatureOnFloor(SHINJUKU[3], shown)).toBe(false);
});

test("site-wide features stay visible on every floor, and everything on none", () => {
  const venue: ReviewFeature = {
    type: "Feature",
    id: "venue-1",
    feature_type: "venue",
    geometry: { type: "Polygon", coordinates: [] },
    properties: {}
  };
  expect(isFeatureOnFloor(venue, new Set(["l-b1"]))).toBe(true);
  expect(isFeatureOnFloor(unit("u-4", "l-b1"), null)).toBe(true);
  expect(isFeatureOnFloor(unit("u-5", "l-2f-in"), new Set())).toBe(false);
});

test("level pickers disambiguate the levels of a shared floor", () => {
  expect(buildLevelOptions(SHINJUKU)).toEqual([
    { id: "l-b1", label: "B1" },
    { id: "l-1f-a", label: "1F 15-16番線" },
    { id: "l-1f-b", label: "1F 13-14番線" },
    // Name identical to the floor label: fall back to the id.
    { id: "l-1f-c", label: "1F (l-1f-c)" },
    { id: "l-2f-in", label: "2Fラチ内" },
    { id: "l-2f-out", label: "2Fラチ外" }
  ]);
});

test("the viewer opens on the lowest floor that actually holds features", () => {
  const groups = buildFloorGroups(SHINJUKU);
  // 新宿 B1 is the lowest floor with anything on it: B2's source rows reference a
  // B1 level, so opening on B2 would show a blank map.
  const b2Only = [...SHINJUKU, level("l-b2", "B2", "B2ラチ内", -2)];
  expect(defaultFloorId(buildFloorGroups(b2Only), [...b2Only, unit("u-1", "l-b1")])).toBe("B1");
  expect(defaultFloorId(groups, [unit("u-2", "l-2f-out")])).toBe("2F");
  // Nothing anywhere: fall back to the lowest floor rather than nothing.
  expect(defaultFloorId(groups, SHINJUKU)).toBe("B1");
  expect(defaultFloorId([], SHINJUKU)).toBeNull();
});

test("floor labels read plain string properties and fall back to the ordinal", () => {
  const plain: ReviewFeature = {
    type: "Feature",
    id: "l-plain",
    feature_type: "level",
    geometry: null,
    properties: { short_name: "3F", ordinal: 3 }
  };
  const bare: ReviewFeature = {
    type: "Feature",
    id: "l-bare",
    feature_type: "level",
    geometry: null,
    properties: { ordinal: 4 }
  };
  expect(buildFloorGroups([plain, bare]).map((floor) => floor.label)).toEqual(["3F", "Ordinal 4"]);
});
