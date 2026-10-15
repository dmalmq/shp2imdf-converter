import type { ImportedFile, SplitPreviewResponse } from "../api/client";
import { countsByFloor, floorOfStem, onFloor, previewShapes, splitBlocked, splitFloors, splitShapes, type DrawnBuilding } from "./split";

function file(stem: string, detected_level: number | null, short_name: string | null = null): ImportedFile {
  return {
    stem,
    geometry_type: "Polygon",
    feature_count: 1,
    attribute_columns: [],
    source_format: "shapefile",
    source_layer: null,
    detected_type: "unit",
    detected_level,
    level_name: null,
    short_name,
    outdoor: false,
    level_category: "unspecified",
    confidence: "green",
    crs_detected: null,
    warnings: []
  };
}

const files = [file("Site_B1_Space", -1), file("Site_1F_Space", 0), file("Site_1F_Floor", 0, "GF"), file("Site_Venue", null)];

const square: DrawnBuilding["corners"] = [
  [139.7, 35.6],
  [139.71, 35.6],
  [139.71, 35.61]
];

function building(name: string): DrawnBuilding {
  return { key: name || "blank", name, corners: square };
}

function preview(totals: number[]): SplitPreviewResponse {
  return {
    shapes: totals.map((total, index) => ({ name: `#${index + 1}`, total, files: {} })),
    unassigned_total: 0,
    unassigned: {},
    owners: {}
  };
}

describe("split floors", () => {
  test("lists each floor once, in order, under the first label a file gives it", () => {
    expect(splitFloors(files)).toEqual([
      { ordinal: -1, label: "B1F" },
      { ordinal: 0, label: "1F" }
    ]);
  });

  test("a file with no floor shows on every floor, others only on their own", () => {
    const floors = floorOfStem(files);
    expect(onFloor("Site_Venue", -1, floors)).toBe(true);
    expect(onFloor("Site_1F_Space", -1, floors)).toBe(false);
    expect(onFloor("Site_1F_Space", 0, floors)).toBe(true);
    expect(onFloor("Site_1F_Space", null, floors)).toBe(true);
  });

  test("sums a building's file counts per floor", () => {
    const counts = countsByFloor({ Site_1F_Space: 3, Site_1F_Floor: 1, Site_Venue: 1, Site_B1_Space: 2 }, floorOfStem(files));
    expect(Object.fromEntries([...counts.entries()].map(([key, value]) => [String(key), value]))).toEqual({
      "-1": 2,
      "0": 4,
      null: 1
    });
  });
});

describe("split shapes", () => {
  test("closes each ring; the preview names by position, the split by the operator's names", () => {
    const drawn = [building(" West "), building("West")];
    expect(previewShapes(drawn).map((shape) => shape.name)).toEqual(["#1", "#2"]);
    expect(splitShapes(drawn).map((shape) => shape.name)).toEqual(["West", "West"]);
    const ring = splitShapes(drawn)[0].polygon.coordinates[0];
    expect(ring).toHaveLength(4);
    expect(ring[3]).toEqual(ring[0]);
  });

  test("blocks until every building is drawn, named uniquely, counted and holds something", () => {
    expect(splitBlocked([], null, null)?.en).toMatch(/Draw a building/);
    expect(splitBlocked([building("A")], null, "“#1” and “#2” overlap")?.en).toMatch(/overlap/);
    expect(splitBlocked([building("A"), building("")], preview([1, 1]), null)?.en).toMatch(/name/);
    expect(splitBlocked([building("A"), building("A ")], preview([1, 1]), null)?.en).toMatch(/share a name/);
    expect(splitBlocked([building("A"), building("B")], null, null)?.en).toMatch(/Counting/);
    expect(splitBlocked([building("A"), building("B")], preview([4, 0]), null)?.en).toBe("Nothing falls inside B.");
    expect(splitBlocked([building("A"), building("B")], preview([4, 2]), null)).toBeNull();
  });
});
