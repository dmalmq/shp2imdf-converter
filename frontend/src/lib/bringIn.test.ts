import type { ImportedFile } from "../api/client";
import { bringInView, floorChoices, floorLabel, queuedDatasets, toRow } from "./bringIn";

function file(stem: string, overrides: Partial<ImportedFile> = {}): ImportedFile {
  return {
    stem,
    geometry_type: "Polygon",
    feature_count: 1,
    attribute_columns: [],
    source_format: "shapefile",
    source_layer: null,
    detected_type: "unit",
    detected_level: 0,
    level_name: null,
    short_name: null,
    outdoor: false,
    level_category: "unspecified",
    confidence: "green",
    crs_detected: null,
    warnings: [],
    ...overrides
  };
}

test("floor labels follow the Japanese convention", () => {
  expect([-2, -1, 0, 1].map(floorLabel)).toEqual(["B2F", "B1F", "1F", "2F"]);
});

test("a type the name did not give is a guess, and a floor-bound file without a floor needs one", () => {
  expect(toRow(file("x", { detected_type: null, confidence: "red", detected_level: null })).reasons).toEqual(["unknown-type"]);
  expect(toRow(file("x", { confidence: "yellow" })).reasons).toEqual(["shape-guess"]);
  expect(toRow(file("x", { detected_level: null })).reasons).toEqual(["no-floor"]);
  expect(toRow(file("x", { detected_type: "venue", detected_level: null })).floor).toEqual({ kind: "whole-station" });
  expect(toRow(file("x", { detected_type: "amenity", detected_level: null })).reasons).toEqual([]);
});

test("floors found are ordered, and two names at one height are kept apart", () => {
  const view = bringInView([
    file("a_2F", { detected_level: 1, short_name: "2F" }),
    file("a_M2F", { detected_level: 1, short_name: "M2F" }),
    file("a_B1", { detected_level: -1 }),
    file("a_Site", { detected_type: "venue", detected_level: null })
  ]);
  expect(view.floors).toEqual([
    { ordinal: -1, labels: ["B1F"] },
    { ordinal: 1, labels: ["2F", "M2F"] }
  ]);
  expect(floorChoices(view.floors)).toEqual([-2, -1, 1, 2]);
  expect(floorChoices([])).toEqual([-1, 0, 1, 2]);
});

test("a shapefile's parts queue as one dataset that knows what it lacks", () => {
  const named = (name: string) => new File(["x"], name);
  const datasets = queuedDatasets(["A.shp", "A.dbf", "B.zip", "C.GPKG"].map(named));
  expect(datasets.map(({ name, kind, missing }) => ({ name, kind, missing }))).toEqual([
    { name: "A", kind: "shapefile", missing: [".shx"] },
    { name: "B.zip", kind: "archive", missing: [] },
    { name: "C.GPKG", kind: "gpkg", missing: [] }
  ]);
});
