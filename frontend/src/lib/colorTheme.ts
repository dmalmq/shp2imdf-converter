import type { FileWithPath } from "react-dropzone";

import type {
  ColorThemeInspection,
  ColorThemeRenderer,
  ColorThemeReport,
  ColorThemeRule,
  ColorThemeStyleFile,
  DatasetFile,
  TileJobStatus,
  VectorTilesAvailability
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
      /**
       * The last vector tile build, whose tiles the viewer can show until the server lets it go,
       * and what it warned about and its checks found, for the operator to read.
       */
      built: { jobId: string; notes: string[] } | null;
    }
  | { phase: "converting"; upload: DatasetUpload; inspection: ColorThemeInspection; progress: number }
  /** Converted, with a vector tile build in line or running; `job` is null until its first status. */
  | { phase: "building"; upload: DatasetUpload; inspection: ColorThemeInspection; jobId: string; job: TileJobStatus | null };

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
  | { type: "buildQueued"; upload: DatasetUpload; jobId: string }
  | { type: "buildProgress"; upload: DatasetUpload; jobId: string; job: TileJobStatus }
  | { type: "converted"; upload: DatasetUpload; filename: string; notes?: string[] }
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
        ? { phase: "checked", upload: state.upload, inspection: event.inspection, error: null, delivered: null, built: null }
        : state;
    case "inspectFailed":
      return state.phase === "inspecting" ? { phase: "empty", error: event.message } : state;
    case "buildQueued":
      return state.phase === "converting"
        ? { phase: "building", upload: state.upload, inspection: state.inspection, jobId: event.jobId, job: null }
        : state;
    case "buildProgress":
      return state.phase === "building" && state.jobId === event.jobId ? { ...state, job: event.job } : state;
    case "converted":
      return state.phase === "converting" || state.phase === "building"
        ? {
            phase: "checked",
            upload: state.upload,
            inspection: state.inspection,
            error: null,
            delivered: event.filename,
            built: state.phase === "building" ? { jobId: state.jobId, notes: event.notes ?? [] } : null
          }
        : state;
    case "convertFailed":
      return state.phase === "converting" || state.phase === "building"
        ? { phase: "checked", upload: state.upload, inspection: state.inspection, error: event.message, delivered: null, built: null }
        : state;
  }
}

export function colorThemeStage(state: ColorThemeState): ColorThemeStageId {
  if (state.phase === "converting" || state.phase === "building" || (state.phase === "checked" && state.delivered)) {
    return "deliver";
  }
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
  styleFiles = false,
  /** Tiles are wanted and can be built: something to download even when no colour changes. */
  vectorTiles = false
): string | null {
  const { field, layers, skipped, totals } = inspection.theme;
  const symbology = symbologyTally(inspection.theme);
  if (totals.recolor > 0 || symbology.rewritten > 0 || vectorTiles) return null;
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

/**
 * Why vector tiles cannot be built for this upload, in the operator's language; null when they can.
 * The server needs a licensed arcpy and the upload exactly one project.
 */
export function vectorTilesBlockedReason(
  availability: VectorTilesAvailability | null,
  inspection: ColorThemeInspection,
  t: (english: string, japanese: string) => string
): string | null {
  if (availability === null || availability.state === "checking") {
    return t("Checking whether this server can build vector tiles…", "このサーバーでベクタータイルを作成できるか確認しています…");
  }
  if (availability.state === "unavailable") {
    switch (availability.reason) {
      case "no_python":
        return t(
          "ArcGIS Pro is not installed on this server, so it cannot build vector tiles.",
          "このサーバーには ArcGIS Pro がインストールされていないため、ベクタータイルを作成できません。"
        );
      case "not_licensed":
        return t(
          "ArcGIS Pro is not licensed for the account that runs this server, so it cannot build vector tiles.",
          "このサーバーを動かしているアカウントに ArcGIS Pro のライセンスがないため、ベクタータイルを作成できません。"
        );
      case "failed":
        return t(
          "This server could not start ArcGIS Pro’s Python, so it cannot build vector tiles.",
          "このサーバーで ArcGIS Pro の Python を起動できないため、ベクタータイルを作成できません。"
        );
    }
  }
  const { projects } = inspection.dataset;
  if (projects === 0) {
    return t(
      "There is no ArcGIS Pro project (.aprx) in this upload to build tiles from.",
      "このアップロードにはタイルの元になる ArcGIS Pro プロジェクト（.aprx）がありません。"
    );
  }
  if (projects > 1) {
    return t(
      `This upload has ${projects} ArcGIS Pro projects (.aprx). Tiles are built from one, so drop a station with exactly one.`,
      `このアップロードには ArcGIS Pro プロジェクト（.aprx）が ${projects} 個あります。タイルは 1 つのプロジェクトから作成するため、プロジェクトが 1 つだけの駅をドロップしてください。`
    );
  }
  const layers = inspection.tile_layers;
  if (layers?.state === "no_layers") {
    return layers.maps.length === 0
      ? t("The project has no map to tile.", "プロジェクトにタイルにするマップがありません。")
      : t(
          `No map in the project has a layer to tile (${layers.maps.join(", ")}).`,
          `プロジェクトのどのマップにもタイルにするレイヤーがありません（${layers.maps.join("、")}）。`
        );
  }
  if (layers?.state === "unreadable") {
    return t(`The project’s layers could not be read: ${layers.detail}`, `プロジェクトのレイヤーを読み込めませんでした: ${layers.detail}`);
  }
  return null;
}

/** Where a vector tile build has got to, in the operator's language. */
export function tileProgress(job: TileJobStatus | null, t: (english: string, japanese: string) => string): string {
  if (job === null) return t("Converted. Starting the vector tile build…", "変換しました。ベクタータイルの作成を開始しています…");
  switch (job.state) {
    case "queued":
      return t(
        `Waiting for another build to finish · number ${job.position} in line`,
        `ほかの作成の完了を待っています · ${job.position} 番目`
      );
    case "running":
      return job.step === 0
        ? t("Opening the project…", "プロジェクトを開いています…")
        : t(`Step ${job.step} of ${job.of} · ${job.label}`, `ステップ ${job.step}/${job.of} · ${job.label}`);
    case "done":
      return t("Vector tiles built.", "ベクタータイルを作成しました。");
    case "failed":
      return job.reason;
  }
}

/** Steps finished, as a percent, for the bar on the button. */
export function tilePercent(job: TileJobStatus | null): number {
  if (job === null || job.state === "queued") return 0;
  if (job.state === "running") return Math.round((Math.max(job.step - 1, 0) / job.of) * 100);
  return 100;
}
