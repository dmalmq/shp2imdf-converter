import type { DatasetFile } from "../api/client";
import {
  categoryRange,
  colorThemeReducer,
  colorThemeStage,
  datasetPath,
  downloadBlockedReason,
  initialColorThemeState,
  type ColorThemeEvent,
  type ColorThemeState
} from "./colorTheme";
import { colorThemeRules, counts, rerunInspection, tokyoInspection } from "./colorTheme.fixtures";

const english = (en: string) => en;
const japanese = (_en: string, ja: string) => ja;

const station = (name: string): DatasetFile[] => [{ file: new File(["x"], `${name}.dbf`), path: `${name}/${name}.dbf` }];
const run = (events: ColorThemeEvent[], from: ColorThemeState = initialColorThemeState) => events.reduce(colorThemeReducer, from);

describe("colorThemeReducer", () => {
  const tokyo = station("tokyo");
  const shinjuku = station("shinjuku");

  test("a drop is inspected, checked, then converted and delivered", () => {
    const inspecting = run([{ type: "dropped", files: tokyo }, { type: "progress", files: tokyo, percent: 40 }]);
    expect(inspecting).toEqual({ phase: "inspecting", files: tokyo, progress: 40 });
    expect(colorThemeStage(inspecting)).toBe("bring-in");

    const checked = run([{ type: "inspected", files: tokyo, inspection: tokyoInspection() }], inspecting);
    expect(checked).toMatchObject({ phase: "checked", files: tokyo, delivered: null });
    expect(colorThemeStage(checked)).toBe("check");

    const converting = run([{ type: "convertStarted" }, { type: "progress", files: tokyo, percent: 70 }], checked);
    expect(converting).toMatchObject({ phase: "converting", progress: 70 });
    expect(colorThemeStage(converting)).toBe("deliver");

    const delivered = run([{ type: "converted", files: tokyo, filename: "tokyo_new-colors.zip" }], converting);
    expect(delivered).toMatchObject({ phase: "checked", delivered: "tokyo_new-colors.zip" });
    expect(colorThemeStage(delivered)).toBe("deliver");
  });

  test("answers for files no longer on screen are ignored", () => {
    const afterReset = run([{ type: "dropped", files: tokyo }, { type: "reset" }]);
    expect(run([{ type: "progress", files: tokyo, percent: 90 }], afterReset)).toBe(afterReset);
    expect(run([{ type: "inspected", files: tokyo, inspection: tokyoInspection() }], afterReset)).toBe(afterReset);
    expect(run([{ type: "inspectFailed", files: tokyo, message: "late" }], afterReset)).toBe(afterReset);

    const second = run([{ type: "dropped", files: tokyo }, { type: "dropped", files: shinjuku }]);
    expect(run([{ type: "progress", files: tokyo, percent: 90 }], second)).toBe(second);
    expect(run([{ type: "inspected", files: tokyo, inspection: tokyoInspection() }], second)).toBe(second);
  });

  test("a late conversion answer does not land on a station dropped since", () => {
    const converting = run([
      { type: "dropped", files: tokyo },
      { type: "inspected", files: tokyo, inspection: tokyoInspection() },
      { type: "convertStarted" }
    ]);
    const replaced = run([{ type: "dropped", files: shinjuku }], converting);
    expect(run([{ type: "converted", files: tokyo, filename: "tokyo_new-colors.zip" }], replaced)).toBe(replaced);
    expect(run([{ type: "progress", files: tokyo, percent: 100 }], replaced)).toBe(replaced);
  });

  test("events that do not fit the phase change nothing", () => {
    expect(run([{ type: "convertStarted" }])).toBe(initialColorThemeState);
    const inspecting = run([{ type: "dropped", files: tokyo }]);
    expect(run([{ type: "convertStarted" }], inspecting)).toBe(inspecting);
    expect(run([{ type: "converted", files: tokyo, filename: "x.zip" }], inspecting)).toBe(inspecting);
  });

  test("a failed inspection goes back to empty with the reason; a failed download keeps the check", () => {
    expect(run([{ type: "dropped", files: tokyo }, { type: "inspectFailed", files: tokyo, message: "Not a zip" }])).toEqual({
      phase: "empty",
      error: "Not a zip"
    });
    const failed = run([
      { type: "dropped", files: tokyo },
      { type: "inspected", files: tokyo, inspection: tokyoInspection() },
      { type: "convertStarted" },
      { type: "convertFailed", files: tokyo, message: "Upload exceeds 200 MB" }
    ]);
    expect(failed).toMatchObject({ phase: "checked", files: tokyo, error: "Upload exceeds 200 MB", delivered: null });
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

test("an override's categories read as a range; a default rule has none", () => {
  expect(categoryRange({ categories: ["B014", "B007", "B010"] })).toBe("B007–B014");
  expect(categoryRange({ categories: ["B007"] })).toBe("B007");
  expect(categoryRange({ categories: null })).toBeNull();
});
