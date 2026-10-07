import {
  categoryRange,
  colorThemeReducer,
  colorThemeStage,
  datasetFiles,
  datasetPath,
  downloadBlockedReason,
  fieldPresence,
  initialColorThemeState,
  keptGroups,
  type ColorThemeEvent,
  type ColorThemeState,
  type DatasetUpload
} from "./colorTheme";
import {
  colorThemeRules,
  counts,
  layerFilesInspection,
  layerFilesRerunInspection,
  rerunInspection,
  shinjukuGeodatabaseInspection,
  shinjukuProjectInspection,
  TOKYO_GDB,
  tokyoGeodatabaseInspection,
  tokyoInspection
} from "./colorTheme.fixtures";

const english = (en: string) => en;
const japanese = (_en: string, ja: string) => ja;

const station = (name: string, lockFilesLeftOut = 0): DatasetUpload => ({
  files: [{ file: new File(["x"], `${name}.dbf`), path: `${name}/${name}.dbf` }],
  lockFilesLeftOut
});
const run = (events: ColorThemeEvent[], from: ColorThemeState = initialColorThemeState) => events.reduce(colorThemeReducer, from);

describe("colorThemeReducer", () => {
  const tokyo = station("tokyo", 1057);
  const shinjuku = station("shinjuku");

  test("a drop is inspected, checked, then converted and delivered, keeping its lock-file count", () => {
    const inspecting = run([{ type: "dropped", upload: tokyo }, { type: "progress", upload: tokyo, percent: 40 }]);
    expect(inspecting).toEqual({ phase: "inspecting", upload: tokyo, progress: 40 });
    expect(colorThemeStage(inspecting)).toBe("bring-in");

    const checked = run([{ type: "inspected", upload: tokyo, inspection: tokyoInspection() }], inspecting);
    expect(checked).toMatchObject({ phase: "checked", upload: tokyo, delivered: null });
    expect(colorThemeStage(checked)).toBe("check");

    const converting = run([{ type: "convertStarted" }, { type: "progress", upload: tokyo, percent: 70 }], checked);
    expect(converting).toMatchObject({ phase: "converting", progress: 70 });
    expect(colorThemeStage(converting)).toBe("deliver");

    const delivered = run([{ type: "converted", upload: tokyo, filename: "tokyo_new-colors.zip" }], converting);
    expect(delivered).toMatchObject({ phase: "checked", upload: { lockFilesLeftOut: 1057 }, delivered: "tokyo_new-colors.zip" });
    expect(colorThemeStage(delivered)).toBe("deliver");
  });

  test("answers for files no longer on screen are ignored", () => {
    const afterReset = run([{ type: "dropped", upload: tokyo }, { type: "reset" }]);
    expect(run([{ type: "progress", upload: tokyo, percent: 90 }], afterReset)).toBe(afterReset);
    expect(run([{ type: "inspected", upload: tokyo, inspection: tokyoInspection() }], afterReset)).toBe(afterReset);
    expect(run([{ type: "inspectFailed", upload: tokyo, message: "late" }], afterReset)).toBe(afterReset);

    const second = run([{ type: "dropped", upload: tokyo }, { type: "dropped", upload: shinjuku }]);
    expect(run([{ type: "progress", upload: tokyo, percent: 90 }], second)).toBe(second);
    expect(run([{ type: "inspected", upload: tokyo, inspection: tokyoInspection() }], second)).toBe(second);
  });

  test("a late conversion answer does not land on a station dropped since", () => {
    const converting = run([
      { type: "dropped", upload: tokyo },
      { type: "inspected", upload: tokyo, inspection: tokyoInspection() },
      { type: "convertStarted" }
    ]);
    const replaced = run([{ type: "dropped", upload: shinjuku }], converting);
    expect(run([{ type: "converted", upload: tokyo, filename: "tokyo_new-colors.zip" }], replaced)).toBe(replaced);
    expect(run([{ type: "progress", upload: tokyo, percent: 100 }], replaced)).toBe(replaced);
  });

  test("events that do not fit the phase change nothing", () => {
    expect(run([{ type: "convertStarted" }])).toBe(initialColorThemeState);
    const inspecting = run([{ type: "dropped", upload: tokyo }]);
    expect(run([{ type: "convertStarted" }], inspecting)).toBe(inspecting);
    expect(run([{ type: "converted", upload: tokyo, filename: "x.zip" }], inspecting)).toBe(inspecting);
  });

  test("a failed inspection goes back to empty with the reason; a failed download keeps the check", () => {
    expect(run([{ type: "dropped", upload: tokyo }, { type: "inspectFailed", upload: tokyo, message: "Not a zip" }])).toEqual({
      phase: "empty",
      error: "Not a zip"
    });
    const failed = run([
      { type: "dropped", upload: tokyo },
      { type: "inspected", upload: tokyo, inspection: tokyoInspection() },
      { type: "convertStarted" },
      { type: "convertFailed", upload: tokyo, message: "Upload exceeds 200 MB" }
    ]);
    expect(failed).toMatchObject({ phase: "checked", upload: tokyo, error: "Upload exceeds 200 MB", delivered: null });
  });
});

describe("datasetPath", () => {
  const withProps = (file: File, props: Record<string, string>) => {
    for (const [key, value] of Object.entries(props)) Object.defineProperty(file, key, { value });
    return file;
  };

  test("keeps the folder a dropped or picked file came from", () => {
    expect(datasetPath(withProps(new File([], "a.dbf"), { relativePath: "/JRTokyoSta_6677.shp/a.dbf" }))).toBe(
      "/JRTokyoSta_6677.shp/a.dbf"
    );
    expect(datasetPath(withProps(new File([], "a.dbf"), { webkitRelativePath: "JRTokyoSta_6677.shp/a.dbf" }))).toBe(
      "JRTokyoSta_6677.shp/a.dbf"
    );
  });

  test("falls back to the name for a loose file", () => {
    expect(datasetPath(new File([], "東京.zip"))).toBe("東京.zip");
  });
});

describe("datasetFiles", () => {
  const dropped = (path: string) => {
    const file = new File([], path.slice(path.lastIndexOf("/") + 1));
    Object.defineProperty(file, "relativePath", { value: path });
    return file;
  };

  test("leaves out lock files inside a .gdb at any depth and in any case, and keeps a .lock elsewhere and every other file", () => {
    const paths: Array<[path: string, sent: boolean]> = [
      ["/JRTokyoSta_3857.gdb/a00000004.gdbtable", true],
      ["/JRTokyoSta_3857.gdb/_gdb.TOKYO-PC.10424.12388.sr.lock", false],
      ["/JRTokyoSta_3857.gdb/a00000004.spx", true],
      ["/JRTokyoSta_3857.gdb/gdb", true],
      ["/NW,POI_20260625東京/JRTokyoSta_3857.GDB/a0000000a.TOKYO-PC.10424.12388.sr.lock", false],
      ["/NW,POI_20260625東京/JRTokyoSta_3857.GDB/a0000000a.gdbtablx", true],
      ["NW,POI_20260625東京/駅/JRShinjukuSta.gdb/a00000004.LAPTOP.4410.9921.sr.lock", false],
      ["/JRTokyoSta_6677.shp/editing.lock", true],
      ["/JRTokyoSta_6677.gdb.bak/a00000004.sr.lock", true],
      ["/JRTokyoSta_6677.shp/JRTokyoSta_1_Space.dbf", true]
    ];
    const upload = datasetFiles(paths.map(([path]) => dropped(path)));
    expect(upload.files.map(({ path }) => path)).toEqual(paths.filter(([, sent]) => sent).map(([path]) => path));
    expect(upload.lockFilesLeftOut).toBe(3);
  });
});

describe("downloadBlockedReason", () => {
  test("is null while anything would change", () => {
    expect(downloadBlockedReason(tokyoInspection(), english)).toBeNull();
  });

  test("says every value is already new when the station was converted before", () => {
    expect(downloadBlockedReason(rerunInspection(), english)).toBe("Every value is already new.");
    expect(downloadBlockedReason(rerunInspection(), japanese)).toBe("すべての値がすでに新しい色です。");
  });

  test("says why when nothing matches or there is no field to edit", () => {
    const inspection = tokyoInspection();
    const unknown = { ...inspection, theme: { ...inspection.theme, rules: colorThemeRules(), totals: counts({ rows: 5, unmapped: 5 }) } };
    expect(downloadBlockedReason(unknown, english)).toBe("No value matches an old colour.");

    const none = { ...inspection, theme: { ...inspection.theme, layers: [], totals: counts() } };
    expect(downloadBlockedReason(none, english)).toBe("No layer has a color2 field.");

    const locked = { ...none, theme: { ...none.theme, skipped: [{ id: "a.dbf", reason: "unreadable" as const }] } };
    expect(downloadBlockedReason(locked, english)).toBe("No color2 field here can be edited.");
  });

  test("lets layer files alone download when a renderer would be redrawn, and says why not once they are new", () => {
    expect(downloadBlockedReason(layerFilesInspection(), english)).toBeNull();
    expect(downloadBlockedReason(layerFilesRerunInspection(), english)).toBe("Every value is already new.");
  });

  test("says nothing can be edited when every layer file is unreadable or its renderers are left alone", () => {
    const files = layerFilesInspection();
    const [lyrx, aprx] = files.theme.symbology;
    const leftAlone = { ...files, theme: { ...files.theme, symbology: [{ ...aprx, renderers: aprx.renderers.slice(2) }] } };
    expect(downloadBlockedReason(leftAlone, english)).toBe("No color2 field here can be edited.");
    const unreadable = { ...files, theme: { ...files.theme, symbology: [{ ...lyrx, unreadable: true, renderers: [] }] } };
    expect(downloadBlockedReason(unreadable, english)).toBe("No color2 field here can be edited.");
    const noColor2 = { ...files, theme: { ...files.theme, symbology: [{ ...lyrx, renderers: [] }] } };
    expect(downloadBlockedReason(noColor2, english)).toBe("No layer has a color2 field.");
  });

  test("says nothing can be edited when every geodatabase is skipped for want of GDAL", () => {
    const gdb = tokyoGeodatabaseInspection();
    const unavailable = {
      ...gdb,
      theme: { ...gdb.theme, layers: [], skipped: [{ id: TOKYO_GDB, reason: "gdb_unavailable" as const }], totals: counts() }
    };
    expect(downloadBlockedReason(unavailable, english)).toBe("No color2 field here can be edited.");
    expect(downloadBlockedReason(unavailable, japanese)).toBe("編集できる color2 フィールドがありません。");
  });

  test("says the new value does not fit when matching rows are left as they are for width", () => {
    const rerun = rerunInspection();
    const narrow = { ...rerun, theme: { ...rerun.theme, totals: counts({ rows: 2167, already_new: 2164, too_wide: 3 }) } };
    expect(downloadBlockedReason(narrow, english)).toBe("Rows match an old colour, but the new value does not fit color2.");
    expect(downloadBlockedReason(narrow, japanese)).toBe("旧カラーに一致する行はありますが、新しい値が color2 に収まりません。");
  });

  test("never repeats the bar's own title", () => {
    const inspection = tokyoInspection();
    const blocked = [
      rerunInspection(),
      { ...inspection, theme: { ...inspection.theme, totals: counts({ rows: 5, unmapped: 5 }) } },
      { ...inspection, theme: { ...inspection.theme, layers: [], totals: counts() } }
    ];
    for (const case_ of blocked) {
      expect(downloadBlockedReason(case_, english)).not.toMatch(/Nothing to change/);
      expect(downloadBlockedReason(case_, japanese)).not.toMatch(/変更なし/);
    }
  });
});

describe("fieldPresence", () => {
  test("a geodatabase whose tables carry category and not color2 is drawn by category", () => {
    expect(fieldPresence(shinjukuGeodatabaseInspection())).toBe("drawn_by_category");
  });

  test("tables with neither field, or a geodatabase that reports no table, have no field", () => {
    const gdb = shinjukuGeodatabaseInspection();
    expect(fieldPresence({ ...gdb, dataset: { ...gdb.dataset, category_only_tables: 0 } })).toBe("no_field");
    expect(fieldPresence({ ...gdb, dataset: { ...gdb.dataset, tables: 0, category_only_tables: 0 } })).toBe("no_field");
    const shapefiles = { ...gdb.dataset, geodatabases: 0, tables: 4, category_only_tables: 0 };
    expect(fieldPresence({ ...gdb, dataset: shapefiles })).toBe("no_field");
  });

  test("an upload with a color2 layer, even a skipped one, is not missing the field", () => {
    expect(fieldPresence(tokyoInspection())).toBe("has_field");
    expect(fieldPresence(rerunInspection())).toBe("has_field");
    const gdb = shinjukuGeodatabaseInspection();
    const skipped = { ...gdb.theme, skipped: [{ id: "JRShinjukuSta.gdb", reason: "gdb_unavailable" as const }] };
    expect(fieldPresence({ ...gdb, theme: skipped })).toBe("has_field");
  });

  test("layer files alone are not a station without the field", () => {
    expect(fieldPresence(layerFilesInspection())).toBe("has_field");
    expect(fieldPresence(shinjukuProjectInspection())).toBe("has_field");
    const files = layerFilesInspection();
    const nothing = { ...files, theme: { ...files.theme, symbology: [{ ...files.theme.symbology[0], renderers: [] }] } };
    expect(fieldPresence(nothing)).toBe("has_field");
  });

  test("a category station dropped with its project is not told to drop the project", () => {
    const gdb = shinjukuGeodatabaseInspection();
    const project = shinjukuProjectInspection().theme.symbology;
    expect(fieldPresence({ ...gdb, theme: { ...gdb.theme, symbology: project } })).toBe("has_field");
    const rerun = project.map((file) => ({
      ...file,
      renderers: file.renderers.map((item) => ({ ...item, outcome: "already_new" as const }))
    }));
    expect(fieldPresence({ ...gdb, theme: { ...gdb.theme, symbology: rerun } })).toBe("has_field");
    const unrelated = [{ ...project[0], renderers: [] }];
    expect(fieldPresence({ ...gdb, theme: { ...gdb.theme, symbology: unrelated } })).toBe("no_field");
  });
});

describe("keptGroups", () => {
  test("layers of one file that keep the same values are one group, in layer order", () => {
    const [group, ...rest] = keptGroups(shinjukuProjectInspection().theme);
    expect(rest).toEqual([]);
    expect(group.path).toBe("shinjuku.aprx");
    expect(group.kept).toEqual(["vegetation"]);
    expect(group.layers).toHaveLength(58);
    expect(group.layers.slice(0, 2)).toEqual(["JRShinjukuSta_0_unit", "JRShinjukuSta_1_unit"]);
  });

  test("different files and different kept values stay apart, and a layer that kept nothing is in no group", () => {
    expect(keptGroups(layerFilesInspection().theme)).toEqual([
      { path: "DemoSta_layers/DemoSta.aprx", layers: ["DemoSta_1_Space"], kept: ["赤"] },
      { path: "DemoSta_layers/DemoSta_units.aprx", layers: ["DemoSta_1_unit", "DemoSta_B1_unit"], kept: ["vegetation"] }
    ]);
  });
});

test("an override's categories read as a range; a default rule has none", () => {
  expect(categoryRange({ categories: ["B014", "B007", "B010"] })).toBe("B007–B014");
  expect(categoryRange({ categories: ["B007"] })).toBe("B007");
  expect(categoryRange({ categories: null })).toBeNull();
});
