import type { ImportedFile } from "../api/client";
import { addToQueue, bringInView, datasetKey, floorChoices, floorLabel, isAccepted, queueNextStep, queuedDatasets, toRow } from "./bringIn";

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
  expect(floorChoices(view.floors).map((choice) => choice.ordinal)).toEqual([-2, -1, 1, 2]);
  expect(floorChoices([]).map((choice) => choice.label)).toEqual(["B1F", "1F", "2F", "3F"]);
});

test("a mezzanine and the floors it moved up are offered by their own labels", () => {
  const view = bringInView([
    file("s_1F", { detected_level: 0 }),
    file("s_M2F", { detected_level: 1, short_name: "M2F" }),
    file("s_2F", { detected_level: 2, short_name: "2F" }),
    file("s_RF", { detected_level: 3, short_name: "RF", outdoor: true })
  ]);
  expect(view.floors.map((floor) => floor.labels)).toEqual([["1F"], ["M2F"], ["2F"], ["RF"]]);
  expect(floorChoices(view.floors)).toEqual([
    { ordinal: -1, label: "B1F" },
    { ordinal: 0, label: "1F" },
    { ordinal: 1, label: "M2F", shortName: "M2F" },
    { ordinal: 2, label: "2F", shortName: "2F" },
    { ordinal: 3, label: "RF", shortName: "RF" },
    { ordinal: 4, label: "5F" }
  ]);
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

const named = (name: string) => new File(["x"], name);

test("parts group by the exact stem, as the importer groups them", () => {
  const datasets = queuedDatasets(["Foo.shp", "foo.shx", "Foo.DBF"].map(named));
  expect(datasets.map(({ name, missing, skipped }) => ({ name, missing, skipped }))).toEqual([
    { name: "foo", missing: [], skipped: true },
    { name: "Foo", missing: [".shx"], skipped: false }
  ]);
  expect(queueNextStep(datasets, "standard").blocked?.en).toBe("1 file needs a decision before you continue");
});

test("parts without a .shp are passed over, and do not hold up the import", () => {
  const datasets = queuedDatasets(["A.shp", "A.shx", "A.dbf", "Stray.cpg"].map(named));
  expect(datasets.find((dataset) => dataset.name === "Stray")).toMatchObject({ skipped: true, missing: [] });
  expect(queueNextStep(datasets, "standard")).toMatchObject({ blocked: null, title: { en: "1 file ready to read" } });
  expect(queueNextStep(queuedDatasets([named("Stray.cpg")]), "standard").blocked).not.toBeNull();
});

/** A file the way a folder drop or a folder picker hands it over, with its path inside the folder. */
const inFolder = (path: string) => {
  const file = new File(["x"], path.split("/").pop() ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

test("a .gdb folder queues as one geodatabase without its lock files, and a project rides along", () => {
  const dropped = [
    "Shinjuku/JRShinjukuSta.gdb/a00000001.gdbtable",
    "Shinjuku/JRShinjukuSta.gdb/a00000001.gdbtablx",
    "Shinjuku/JRShinjukuSta.gdb/gdb",
    "Shinjuku/JRShinjukuSta.gdb/a00000009.gdbtable.sr.lock",
    "Shinjuku/Shinjuku.aprx",
    "Shinjuku/ラベル.xlsx"
  ].map(inFolder);
  const accepted = dropped.filter(isAccepted);
  expect(accepted.map((file) => file.name)).toEqual(["a00000001.gdbtable", "a00000001.gdbtablx", "gdb", "Shinjuku.aprx"]);

  const datasets = queuedDatasets(accepted);
  expect(datasets.map(({ name, kind }) => ({ name, kind }))).toEqual([
    { name: "JRShinjukuSta.gdb", kind: "gdb" },
    { name: "Shinjuku.aprx", kind: "project" }
  ]);
  expect(queueNextStep(datasets, "standard")).toMatchObject({ blocked: null, title: { en: "1 file ready to read" } });
  expect(queueNextStep(datasets, "imdf_shapefile").blocked?.en).toMatch(/not GeoPackages or geodatabases/);
});

test("a project alone has nothing to read", () => {
  expect(queueNextStep(queuedDatasets([named("Shinjuku.aprx")]), "standard").blocked).not.toBeNull();
});

test("two geodatabases with the same table names stay apart in the queue", () => {
  const queued = addToQueue(
    [inFolder("A.gdb/a00000001.gdbtable")],
    [inFolder("B.gdb/a00000001.gdbtable"), inFolder("A.gdb/a00000001.gdbtable")]
  );
  expect(queued.map((file) => file.webkitRelativePath)).toEqual(["B.gdb/a00000001.gdbtable", "A.gdb/a00000001.gdbtable"]);
  expect(queuedDatasets(queued).map((dataset) => dataset.name)).toEqual(["A.gdb", "B.gdb"]);
});

test("same-named shapefiles in two folders queue apart, each with its own parts, and leave out apart", () => {
  const queued = ["Station/A/Space.shp", "Station/A/Space.shx", "Station/A/Space.dbf", "Station/B/Space.shp"].map(inFolder);
  const datasets = queuedDatasets(queued);
  expect(datasets.map(({ name, missing }) => ({ name, missing }))).toEqual([
    { name: "Station/A/Space", missing: [] },
    { name: "Station/B/Space", missing: [".shx", ".dbf"] }
  ]);
  expect(queueNextStep(datasets, "standard").blocked).not.toBeNull();
  const kept = queued.filter((file) => datasetKey(file) !== datasets[1].key);
  expect(kept.map((file) => file.webkitRelativePath)).toEqual(["Station/A/Space.shp", "Station/A/Space.shx", "Station/A/Space.dbf"]);
});

test("a stem in one folder keeps its bare name", () => {
  expect(queuedDatasets(["Station/1F/Space.shp", "Station/1F/Space.dbf"].map(inFolder)).map((dataset) => dataset.name)).toEqual(["Space"]);
});

test("same-named GeoPackages or projects in two folders queue as two rows, and leave out apart", () => {
  const queued = ["Station/A/map.gpkg", "Station/B/map.gpkg", "Station/A/新宿.aprx", "Station/B/新宿.aprx"].map(inFolder);
  const datasets = queuedDatasets(queued);
  expect(datasets.map(({ name, kind }) => ({ name, kind }))).toEqual([
    { name: "Station/A/map.gpkg", kind: "gpkg" },
    { name: "Station/A/新宿.aprx", kind: "project" },
    { name: "Station/B/map.gpkg", kind: "gpkg" },
    { name: "Station/B/新宿.aprx", kind: "project" }
  ]);
  const leftOut = datasets.find((dataset) => dataset.name === "Station/A/map.gpkg")!.key;
  expect(queued.filter((file) => datasetKey(file) !== leftOut).map((file) => file.webkitRelativePath)).toEqual([
    "Station/B/map.gpkg",
    "Station/A/新宿.aprx",
    "Station/B/新宿.aprx"
  ]);
  expect(queuedDatasets([inFolder("Station/A/map.gpkg")])[0].name).toBe("map.gpkg");
});
