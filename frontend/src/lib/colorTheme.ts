import type { FileWithPath } from "react-dropzone";

import type {
  ColorThemeInspection,
  ColorThemeRenderer,
  ColorThemeReport,
  ColorThemeRule,
  ColorThemeStyleFile,
  DatasetFile
} from "../api/client";
import type { ColorThemeStageId } from "../components/shell/stages";

/** What one drop sends, and how many stale lock files inside a `.gdb` it kept back. */
export type DatasetUpload = { files: DatasetFile[]; lockFilesLeftOut: number };

/**
 * One station at a time. The upload stays in the browser after the inspection,
 * so Download sends it again without another drop.
 */
export type ColorThemeState =
  | { phase: "empty"; error: string | null }
  | { phase: "inspecting"; upload: DatasetUpload; progress: number }
  | {
      phase: "checked";
      upload: DatasetUpload;
      inspection: ColorThemeInspection;
      error: string | null;
      /** File name of the last download. */
      delivered: string | null;
    }
  | { phase: "converting"; upload: DatasetUpload; inspection: ColorThemeInspection; progress: number };

/**
 * An answer names the upload it was for, so one that arrives after a reset or
 * a new drop matches nothing and is ignored.
 */
export type ColorThemeEvent =
  | { type: "dropped"; upload: DatasetUpload }
  | { type: "progress"; upload: DatasetUpload; percent: number }
  | { type: "inspected"; upload: DatasetUpload; inspection: ColorThemeInspection }
  | { type: "inspectFailed"; upload: DatasetUpload; message: string }
  | { type: "convertStarted" }
  | { type: "converted"; upload: DatasetUpload; filename: string }
  | { type: "convertFailed"; upload: DatasetUpload; message: string }
  | { type: "reset" };

export const initialColorThemeState: ColorThemeState = { phase: "empty", error: null };

export function colorThemeReducer(state: ColorThemeState, event: ColorThemeEvent): ColorThemeState {
  switch (event.type) {
    case "dropped":
      return { phase: "inspecting", upload: event.upload, progress: 0 };
    case "reset":
      return initialColorThemeState;
    case "convertStarted":
      return state.phase === "checked"
        ? { phase: "converting", upload: state.upload, inspection: state.inspection, progress: 0 }
        : state;
  }
  if (!("upload" in state) || state.upload !== event.upload) return state;
  switch (event.type) {
    case "progress":
      return state.phase === "inspecting" || state.phase === "converting" ? { ...state, progress: event.percent } : state;
    case "inspected":
      return state.phase === "inspecting"
        ? { phase: "checked", upload: state.upload, inspection: event.inspection, error: null, delivered: null }
        : state;
    case "inspectFailed":
      return state.phase === "inspecting" ? { phase: "empty", error: event.message } : state;
    case "converted":
      return state.phase === "converting"
        ? { phase: "checked", upload: state.upload, inspection: state.inspection, error: null, delivered: event.filename }
        : state;
    case "convertFailed":
      return state.phase === "converting"
        ? { phase: "checked", upload: state.upload, inspection: state.inspection, error: event.message, delivered: null }
        : state;
  }
}

export function colorThemeStage(state: ColorThemeState): ColorThemeStageId {
  if (state.phase === "converting" || (state.phase === "checked" && state.delivered)) return "deliver";
  return state.phase === "checked" ? "check" : "bring-in";
}

/**
 * The path a file had inside what was dropped or picked. file-selector writes
 * "/Folder/a.dbf" for a dropped folder and "./a.dbf" for a loose file; the
 * server normalises both, since it has to check paths anyway.
 */
export function datasetPath(file: FileWithPath): string {
  return file.relativePath || file.webkitRelativePath || file.name;
}

/** True for a `.gdb` folder and everything under one, the way the server partitions an upload. */
export function inGeodatabase(path: string): boolean {
  return path
    .toLowerCase()
    .split("/")
    .some((segment) => segment.endsWith(".gdb"));
}

const isGeodatabaseLock = (path: string) => path.toLowerCase().endsWith(".lock") && inGeodatabase(path);

/**
 * Every file but the stale lock files inside a `.gdb`: Tokyo's holds 1,057 of them,
 * a third of its files, enough to push a two-station drop toward the multipart limit.
 */
export function datasetFiles(files: ReadonlyArray<FileWithPath>): DatasetUpload {
  const all = files.map((file) => ({ file, path: datasetPath(file) }));
  const kept = all.filter(({ path }) => !isGeodatabaseLock(path));
  return { files: kept, lockFilesLeftOut: all.length - kept.length };
}

/** What the layer files and projects in an upload come to. */
export type SymbologyTally = {
  files: number;
  /** Files with a renderer rewritten: the only ones that come back changed. */
  changedFiles: number;
  rewritten: number;
  alreadyNew: number;
  /** Renderers left alone, project members that did not parse among them. */
  leftAlone: number;
  unreadableFiles: number;
};

export function symbologyTally(report: Pick<ColorThemeReport, "symbology">): SymbologyTally {
  const renderers = report.symbology.flatMap((file) => file.renderers);
  const count = (outcome: ColorThemeRenderer["outcome"]) => renderers.filter((renderer) => renderer.outcome === outcome).length;
  return {
    files: report.symbology.length,
    changedFiles: report.symbology.filter((file) => file.renderers.some((renderer) => renderer.outcome === "rewritten")).length,
    rewritten: count("rewritten"),
    alreadyNew: count("already_new"),
    leftAlone: count("left_alone"),
    unreadableFiles: report.symbology.filter((file) => file.unreadable).length
  };
}

/**
 * Why an upload that holds tables comes to nothing: `no_field` when none of them carries the colour field,
 * `drawn_by_category` when they carry the category field instead and no layer file or project came with them.
 * `has_field` whenever a table carries the field or the upload's layer files did the work.
 */
export type FieldPresence = "has_field" | "no_field" | "drawn_by_category";

export function fieldPresence(inspection: ColorThemeInspection): FieldPresence {
  const { dataset, theme } = inspection;
  const symbology = symbologyTally(theme);
  if (theme.layers.length + theme.skipped.length > 0) return "has_field";
  if (dataset.tables + dataset.geodatabases === 0) return "has_field";
  if (symbology.rewritten + symbology.alreadyNew > 0) return "has_field";
  return dataset.category_only_tables > 0 && symbology.files === 0 ? "drawn_by_category" : "no_field";
}

/** One line under Needs attention for the layers of one file that kept the same unknown values. */
export type KeptGroup = { path: string; layers: (string | null)[]; kept: string[] };

/**
 * Renderers that kept a class the table does not know, grouped by file and by what they kept:
 * Shinjuku's 58 unit layers all keep `vegetation`, which is one thing to read, not 58.
 */
export function keptGroups(report: Pick<ColorThemeReport, "symbology">): KeptGroup[] {
  const groups = new Map<string, KeptGroup>();
  for (const file of report.symbology) {
    for (const renderer of file.renderers) {
      if (renderer.outcome === "left_alone" || renderer.kept.length === 0) continue;
      const key = JSON.stringify([file.path, renderer.kept]);
      const group = groups.get(key) ?? { path: file.path, layers: [], kept: renderer.kept };
      group.layers.push(renderer.layer);
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

/** One polygon shapefile and the style files beside it: those a download adds and those it already had. */
export type StyledLayer = { layer: string; field: string; classes: string[]; added: ColorThemeStyleFile[]; kept: ColorThemeStyleFile[] };

/** The report's style files by the layer they style, in upload order. */
export function styledLayers(report: Pick<ColorThemeReport, "style_files">): StyledLayer[] {
  const layers = new Map<string, StyledLayer>();
  for (const file of report.style_files) {
    const entry = layers.get(file.layer) ?? { layer: file.layer, field: file.field, classes: file.classes, added: [], kept: [] };
    entry[file.outcome].push(file);
    layers.set(file.layer, entry);
  }
  return [...layers.values()];
}

/** How many files asking for style files adds to the download. */
export function styleFilesAdded(report: Pick<ColorThemeReport, "style_files">): number {
  return report.style_files.filter((file) => file.outcome === "added").length;
}

/**
 * Why Download cannot run, in the operator's language; null when it can,
 * which is when rows or renderers would be rewritten, or style files are
 * asked for and there are some to add.
 * Each reason is a whole sentence: it is read under the bar's "Nothing to
 * change", under the Deliver stage, and alone as the button's hint.
 */
export function downloadBlockedReason(
  inspection: ColorThemeInspection,
  t: (english: string, japanese: string) => string,
  styleFiles = false
): string | null {
  const { field, layers, skipped, totals } = inspection.theme;
  const symbology = symbologyTally(inspection.theme);
  if (totals.recolor > 0 || symbology.rewritten > 0) return null;
  if (styleFiles && styleFilesAdded(inspection.theme) > 0) return null;
  const editable = layers.length + symbology.alreadyNew;
  if (editable === 0 && skipped.length + symbology.leftAlone + symbology.unreadableFiles === 0) {
    return t(`No layer has a ${field} field.`, `${field} フィールドのあるレイヤーがありません。`);
  }
  if (editable === 0) {
    return t(`No ${field} field here can be edited.`, `編集できる ${field} フィールドがありません。`);
  }
  // Before "already new" and "no match": these rows do match, and a wider field would let them change.
  if (totals.too_wide > 0) {
    return t(
      `Rows match an old colour, but the new value does not fit ${field}.`,
      `旧カラーに一致する行はありますが、新しい値が ${field} に収まりません。`
    );
  }
  if ((totals.already_new > 0 || symbology.alreadyNew > 0) && totals.unmapped + totals.undecodable === 0) {
    return t("Every value is already new.", "すべての値がすでに新しい色です。");
  }
  return t("No value matches an old colour.", "旧カラーに一致する値がありません。");
}

/** "B007–B014" for a category override; null for a rule that covers every category. */
export function categoryRange(rule: Pick<ColorThemeRule, "categories">): string | null {
  if (!rule.categories || rule.categories.length === 0) return null;
  const sorted = [...rule.categories].sort();
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}–${sorted[sorted.length - 1]}`;
}
