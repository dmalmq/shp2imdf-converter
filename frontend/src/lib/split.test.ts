import type { ImportedFile, LayerGroup, SplitPreviewResponse } from "../api/client";
import {
  countsByFloor,
  filterFiles,
  floorOfStem,
  onFloor,
  pickedStems,
  previewBlocked,
  previewShapes,
  splitBlocked,
  splitFloors,
  splitShapes,
  type Building
} from "./split";

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

const square: Building["corners"] = [
  [139.7, 35.6],
  [139.71, 35.6],
  [139.71, 35.61]
];

function building(name: string, picks: Partial<Building> = {}): Building {
  return { key: name || "blank", name, corners: square, files: [], groups: [], ...picks };
}

const groups: LayerGroup[] = [
  { id: "g:west", name: "1F › JRWest_1F", kind: "project_group", stems: ["Site_1F_Space", "Site_1F_Floor"] },
  { id: "g:b1", name: "B1", kind: "feature_dataset", stems: ["Site_B1_Space"] }
];

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
    expect(previewShapes(drawn, []).map((shape) => shape.name)).toEqual(["#1", "#2"]);
    expect(splitShapes(drawn, []).map((shape) => shape.name)).toEqual(["West", "West"]);
    const ring = splitShapes(drawn, [])[0].polygon?.coordinates[0];
    expect(ring).toHaveLength(4);
    expect(ring?.[3]).toEqual(ring?.[0]);
    expect(splitShapes(drawn, [])[0]).not.toHaveProperty("files");
  });

  test("a building sends its picked files, through groups too, each once, and no polygon when none was drawn", () => {
    const picked = building("West", { corners: null, files: ["Site_1F_Space", "Site_Venue"], groups: ["g:west"] });
    expect(pickedStems(picked, groups)).toEqual(["Site_1F_Space", "Site_Venue", "Site_1F_Floor"]);
    expect(splitShapes([picked], groups)).toEqual([{ name: "West", files: ["Site_1F_Space", "Site_Venue", "Site_1F_Floor"] }]);
  });

  test("the preview waits for every building to hold something, and for each file to have one building", () => {
    expect(previewBlocked([building("A", { corners: null })], groups)?.en).toBe("A has neither a shape nor picked layers.");
    const both = [building("A", { groups: ["g:west"] }), building("B", { corners: null, files: ["Site_1F_Floor"] })];
    expect(previewBlocked(both, groups)?.en).toBe("Site_1F_Floor is picked by A, B; a file can go to one building only.");
    expect(splitBlocked(both, groups, preview([1, 1]), null)?.en).toMatch(/one building only/);
    expect(previewBlocked([building("A", { corners: null, groups: ["g:b1"] })], groups)).toBeNull();
  });

  test("blocks until every building is drawn or picked, named uniquely, counted and holds something", () => {
    expect(splitBlocked([], [], null, null)?.en).toMatch(/Draw a building or pick/);
    expect(splitBlocked([building("A")], [], null, "“#1” and “#2” overlap")?.en).toMatch(/overlap/);
    expect(splitBlocked([building("A"), building("")], [], preview([1, 1]), null)?.en).toMatch(/name/);
    expect(splitBlocked([building("A"), building("A ")], [], preview([1, 1]), null)?.en).toMatch(/share a name/);
    expect(splitBlocked([building("A"), building("B")], [], null, null)?.en).toMatch(/Counting/);
    expect(splitBlocked([building("A"), building("B")], [], preview([4, 0]), null)?.en).toBe("Nothing goes to B.");
    expect(splitBlocked([building("A"), building("B")], [], preview([4, 2]), null)).toBeNull();
  });

  test("the layer filter matches stem, layer and feature dataset", () => {
    const gdb = [
      { ...file("OdakyuShinjukuSta_B1_level", -1), source_format: "gdb" as const, feature_dataset: "Odakyu" },
      { ...file("背景_B1_Space", -1), source_format: "gdb" as const, source_layer: "背景 B1 Space" },
      file("Site_1F_Space", 0)
    ];
    expect(filterFiles(gdb, "odakyu").map((item) => item.stem)).toEqual(["OdakyuShinjukuSta_B1_level"]);
    expect(filterFiles(gdb, "背景 B1").map((item) => item.stem)).toEqual(["背景_B1_Space"]);
    expect(filterFiles(gdb, " ")).toHaveLength(3);
  });
});
