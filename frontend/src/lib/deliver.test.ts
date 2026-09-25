import { describe, expect, test } from "vitest";

import type { ExportContents, ExportFormat } from "../api/client";
import { buildDeliverView, defaultShapefileOptions, shapefileRequest, treeLines, type DeliverInput } from "./deliver";

const ODC_ENTRIES = [
  ...["Site", "Building", "B1_Floor", "B1_Space", "1_Floor", "1_Space", "1_Opening"].flatMap((layer) =>
    [".shp", ".shx", ".dbf", ".prj", ".cpg"].map((ext) => `JRTokyoSta_${layer}${ext}`)
  ),
  "export_report.json"
];

function contents(overrides: Partial<Record<ExportFormat, Partial<ExportContents>>> = {}): ExportContents[] {
  const base: Record<ExportFormat, ExportContents> = {
    imdf: {
      format: "imdf",
      filename: "Tokyo_Station.imdf",
      entries: ["manifest.json", "venue.geojson", "unit.geojson"],
      unavailable: null,
      reason: null,
      rows_skipped: []
    },
    imdf_zip: {
      format: "imdf_zip",
      filename: "Tokyo_Station.zip",
      entries: ["manifest.json", "venue.geojson", "unit.geojson"],
      unavailable: null,
      reason: null,
      rows_skipped: []
    },
    shapefiles: {
      format: "shapefiles",
      filename: "Tokyo_Station_shapefiles.zip",
      entries: ["JRTokyoSta_B1_unit.shp", "JRTokyoSta_B1_unit.dbf", "export_report.json"],
      unavailable: null,
      reason: null,
      rows_skipped: []
    },
    odc2026_shapefiles: {
      format: "odc2026_shapefiles",
      filename: "JRTokyoSta_odc2026_shapefiles.zip",
      entries: ODC_ENTRIES,
      unavailable: null,
      reason: null,
      rows_skipped: []
    },
    qgis_project: {
      format: "qgis_project",
      filename: "JRTokyoSta_qgis_project.zip",
      entries: ["JRTokyoSta_qgis.qgz", ...ODC_ENTRIES],
      unavailable: null,
      reason: null,
      rows_skipped: []
    }
  };
  return (Object.keys(base) as ExportFormat[]).map((format) => ({ ...base[format], ...overrides[format] }));
}

function input(overrides: Partial<DeliverInput> = {}): DeliverInput {
  return {
    selected: new Set<ExportFormat>(["imdf"]),
    contents: contents(),
    checks: { error_count: 0, warning_count: 5 },
    checking: false,
    geoPackage: false,
    options: { ...defaultShapefileOptions(null), prefix: "JRTokyoSta" },
    stems: ["JRTokyoSta_B1_Space", "JRTokyoSta_1_Space"],
    ...overrides
  };
}

const english = (entries: string[]) => treeLines(entries).map((line) => line.en);

describe("treeLines", () => {
  test("puts the IMDF feature files on one line", () => {
    expect(english(["manifest.json", "venue.geojson", "unit.geojson"])).toEqual(["manifest · venue · unit"]);
  });

  test("names ODC's floors and the layers they carry, from the real file names, in both languages", () => {
    expect(english(ODC_ENTRIES)).toEqual([
      "_Site · _Building",
      "per floor ×2 (B1 · 1): _Floor _Space _Opening",
      "export_report.json"
    ]);
    expect(treeLines(ODC_ENTRIES)[1].ja).toBe("フロアごと ×2（B1 · 1）：_Floor _Space _Opening");
  });

  test("lists the QGIS project file above the ODC files it comes with", () => {
    expect(english(["JRTokyoSta_qgis.qgz", ...ODC_ENTRIES])[0]).toBe("JRTokyoSta_qgis.qgz");
  });
});

describe("buildDeliverView", () => {
  test("groups the outputs by audience", () => {
    const view = buildDeliverView(input());
    expect(view.groups.map((group) => [group.label.en, group.outputs.map((output) => output.format)])).toEqual([
      ["For Apple", ["imdf", "imdf_zip"]],
      ["For GIS and open data", ["odc2026_shapefiles", "qgis_project", "shapefiles"]]
    ]);
    expect(view.groups[0].outputs[0].filename).toBe("Tokyo_Station.imdf");
  });

  test("the tree, coordinate systems and button follow what is chosen", () => {
    const view = buildDeliverView(
      input({ selected: new Set<ExportFormat>(["qgis_project", "imdf", "odc2026_shapefiles"]) })
    );
    expect(view.toCreate).toEqual(["imdf", "odc2026_shapefiles", "qgis_project"]);
    expect(view.tree.map((node) => node.filename)).toEqual([
      "Tokyo_Station.imdf",
      "JRTokyoSta_odc2026_shapefiles.zip",
      "JRTokyoSta_qgis_project.zip"
    ]);
    expect(view.crs.map((line) => line.en)).toEqual([
      "IMDF in WGS 84 (EPSG:4326), as the spec requires",
      "ODC files in JGD2011 (EPSG:6668), as the GSI spec asks"
    ]);
    expect(view.next.action.en).toBe("Create 3 outputs");
    expect(view.next.blocked).toBeNull();
    expect(view.showPrefix).toBe(true);
  });

  test("the ODC prefix starts blank and must be given; the dataset stem is only offered", () => {
    expect(defaultShapefileOptions(null).prefix).toBe("");
    const options = { ...input().options, prefix: " " };
    const noPrefix = contents({
      odc2026_shapefiles: { filename: null, entries: [], unavailable: "needs a file name prefix", reason: "no_prefix" }
    });
    const view = buildDeliverView(
      input({ selected: new Set<ExportFormat>(["odc2026_shapefiles"]), options, contents: noPrefix })
    );
    expect(view.next.blocked?.en).toBe("Enter a file prefix for the ODC files.");
    expect(view.groups[1].outputs[0].unavailable).toBeNull();
    expect(view.suggestedPrefix).toBe("JRTokyoSta");
    expect(buildDeliverView(input()).suggestedPrefix).toBeNull();
  });

  test("a reason the server gives is worded in both languages, its English text in English only", () => {
    const failed = contents({
      shapefiles: { filename: null, entries: [], unavailable: "disk full", reason: "failed" }
    });
    const card = buildDeliverView(input({ contents: failed })).groups[1].outputs[2];
    expect(card.unavailable).toEqual({
      en: "Can’t list this output: disk full",
      ja: "この出力を確認できませんでした。"
    });
    const qgis = contents({
      qgis_project: { filename: null, entries: [], unavailable: "QGIS is not installed", reason: "qgis_missing" }
    });
    expect(buildDeliverView(input({ contents: qgis })).groups[1].outputs[1].unavailable?.ja).toBe(
      "この PC に QGIS がインストールされていません。"
    );
  });

  test("nothing chosen blocks the button", () => {
    expect(buildDeliverView(input({ selected: new Set() })).next.blocked?.en).toBe("Pick at least one output.");
  });

  test("a GeoPackage project cannot choose the shapefile outputs", () => {
    const view = buildDeliverView(input({ geoPackage: true, selected: new Set<ExportFormat>(["imdf", "shapefiles"]) }));
    expect(view.groups[1].outputs.every((output) => output.unavailable !== null)).toBe(true);
    expect(view.toCreate).toEqual(["imdf"]);
  });

  test("a stale validation says so and offers Check again", () => {
    const view = buildDeliverView(input({ checks: null }));
    expect(view.status.tone).toBe("stale");
    expect(view.status.action?.goes).toBe("check-again");
    expect(view.lastChecks).toEqual([
      { tone: "stale", text: expect.objectContaining({ en: "Not checked since the last change" }) }
    ]);
  });

  test("last checks are the stored blockers and can-wait counts, plus rows ODC leaves out", () => {
    const skipped = contents({
      odc2026_shapefiles: { rows_skipped: [{ layer: "JRTokyoSta_1_Space" }, { layer: "JRTokyoSta_1_Space" }] }
    });
    const view = buildDeliverView(
      input({
        checks: { error_count: 2, warning_count: 1 },
        contents: skipped,
        selected: new Set<ExportFormat>(["qgis_project"])
      })
    );
    expect(view.status.tone).toBe("danger");
    expect(view.lastChecks.map((row) => row.text.en)).toEqual([
      "2 to fix before delivery",
      "1 can wait",
      "2 features are left out of the ODC files: the shape doesn’t fit its layer"
    ]);
  });
});

describe("shapefileRequest", () => {
  const options = {
    ...defaultShapefileOptions({
      mappings: { unit: { code_column: "CODE" } },
      company_mappings: { B0001: "room", B0002: "Room" }
    } as never),
    prefix: "JRTokyoSta"
  };

  test("round-trip exports overwrite the mapped code column by default", () => {
    expect(options.categoryField).toBe("CODE");
    expect(options.legacyMapText).toBe("room=B0001");
    expect(shapefileRequest("shapefiles", options)).toEqual({
      request: {
        profile: "imdf_roundtrip",
        mode: "source_update",
        encoding: "preserve_source",
        include_report: true,
        unit: {
          write_imdf_category: true,
          imdf_category_field: "CODE",
          overwrite_legacy_code_field: null,
          legacy_code_map: {}
        }
      }
    });
  });

  test("a legacy field must differ from the category field and its mappings must parse", () => {
    expect(shapefileRequest("shapefiles", { ...options, legacyCodeField: "code" })).toHaveProperty("error");
    expect(
      shapefileRequest("shapefiles", { ...options, legacyCodeField: "OLD", legacyMapText: "nonsense" })
    ).toHaveProperty("error");
  });

  test("ODC and QGIS send the prefix; IMDF sends nothing", () => {
    expect(shapefileRequest("qgis_project", options)).toMatchObject({
      request: { profile: "odc2026", export_name: "JRTokyoSta" }
    });
    expect(shapefileRequest("imdf", options)).toEqual({ request: null });
  });
});
