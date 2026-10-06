import type { FileWithPath } from "react-dropzone";

import type { ColorThemeInspection, ColorThemeRule, DatasetFile } from "../api/client";
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

/**
 * Why Download cannot run, in the operator's language; null when it can.
 * Each reason is a whole sentence: it is read under the bar's "Nothing to
 * change", under the Deliver stage, and alone as the button's hint.
 */
export function downloadBlockedReason(
  inspection: ColorThemeInspection,
  t: (english: string, japanese: string) => string
): string | null {
  const { field, layers, skipped, totals } = inspection.theme;
  if (totals.recolor > 0) return null;
  if (layers.length === 0 && skipped.length === 0) {
    return t(`No layer has a ${field} field.`, `${field} フィールドのあるレイヤーがありません。`);
  }
  if (layers.length === 0) {
    return t(`No ${field} field here can be edited.`, `編集できる ${field} フィールドがありません。`);
  }
  // Before "already new" and "no match": these rows do match, and a wider field would let them change.
  if (totals.too_wide > 0) {
    return t(
      `Rows match an old colour, but the new value does not fit ${field}.`,
      `旧カラーに一致する行はありますが、新しい値が ${field} に収まりません。`
    );
  }
  if (totals.already_new > 0 && totals.unmapped + totals.undecodable === 0) {
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
