import type { ImportedFile } from "../api/client";
import type { Bilingual } from "../components/shell/stages";
import type { ImportProfile } from "../store/useAppStore";

/** Types whose features sit on one floor, so a file of them needs one. */
export const LEVEL_REQUIRED_TYPES = new Set(["unit", "opening", "fixture", "detail", "kiosk", "section"]);

const WHOLE_STATION_TYPES = new Set(["venue", "building"]);

export const TYPE_LABELS: Record<string, Bilingual> = {
  unit: { en: "Units (rooms & spaces)", ja: "ユニット（部屋・空間）" },
  opening: { en: "Openings (doors, gates)", ja: "開口部（ドア・改札）" },
  fixture: { en: "Fixtures", ja: "什器" },
  detail: { en: "Details (line drawings)", ja: "詳細（線画）" },
  level: { en: "Floor outlines", ja: "フロア外形" },
  building: { en: "Buildings", ja: "建物" },
  venue: { en: "Venue boundary", ja: "施設の境界" },
  amenity: { en: "Amenities", ja: "アメニティ" },
  anchor: { en: "Anchors", ja: "アンカー" },
  geofence: { en: "Geofences", ja: "ジオフェンス" },
  kiosk: { en: "Kiosks", ja: "キオスク" },
  occupant: { en: "Occupants", ja: "テナント" },
  relationship: { en: "Relationships", ja: "リレーション" },
  section: { en: "Sections", ja: "セクション" },
  facility: { en: "Facilities", ja: "施設" }
};

export const TYPE_OPTIONS = Object.keys(TYPE_LABELS);

/** Why a file is in "Needs you". */
export type NeedReason = "unknown-type" | "shape-guess" | "no-floor";

export type RowFloor =
  | { kind: "level"; ordinal: number; label: string }
  | { kind: "missing" }
  | { kind: "whole-station" }
  | { kind: "none" };

export type BringInRow = {
  stem: string;
  /** Null until the name, or the operator, says what the file holds. */
  type: string | null;
  /** What the shapes alone suggest, when the name said nothing. */
  shapeGuess: string | null;
  floor: RowFloor;
  shapes: number;
  reasons: NeedReason[];
  warnings: string[];
};

export type FloorFound = { ordinal: number; labels: string[] };

export type BringInView = {
  filesRead: number;
  needsYou: BringInRow[];
  looksRight: BringInRow[];
  floors: FloorFound[];
};

/** Japanese convention, the inverse of the detector: 0 is 1F, -1 is B1F. */
export function floorLabel(ordinal: number): string {
  return ordinal < 0 ? `B${Math.abs(ordinal)}F` : `${ordinal + 1}F`;
}

function rowFloor(file: ImportedFile, type: string | null): RowFloor {
  if (type && WHOLE_STATION_TYPES.has(type)) return { kind: "whole-station" };
  if (!LEVEL_REQUIRED_TYPES.has(type ?? file.detected_type ?? "")) return { kind: "none" };
  if (file.detected_level === null) return { kind: "missing" };
  return {
    kind: "level",
    ordinal: file.detected_level,
    label: file.short_name?.trim() || floorLabel(file.detected_level)
  };
}

export function toRow(file: ImportedFile): BringInRow {
  const named = file.confidence === "green" && Boolean(file.detected_type);
  const type = named ? file.detected_type : null;
  const floor = rowFloor(file, type);
  const reasons: NeedReason[] = [];
  if (!named) reasons.push(file.detected_type ? "shape-guess" : "unknown-type");
  if (floor.kind === "missing") reasons.push("no-floor");
  return {
    stem: file.stem,
    type,
    shapeGuess: named ? null : file.detected_type,
    floor,
    shapes: file.feature_count,
    reasons,
    warnings: file.warnings
  };
}

export function bringInView(files: ReadonlyArray<ImportedFile>): BringInView {
  const rows = files.map(toRow);
  const byOrdinal = new Map<number, Set<string>>();
  for (const row of rows) {
    if (row.floor.kind !== "level") continue;
    const labels = byOrdinal.get(row.floor.ordinal) ?? new Set<string>();
    labels.add(row.floor.label);
    byOrdinal.set(row.floor.ordinal, labels);
  }
  return {
    filesRead: files.length,
    needsYou: rows.filter((row) => row.reasons.length > 0),
    looksRight: rows.filter((row) => row.reasons.length === 0),
    floors: [...byOrdinal.entries()]
      .sort(([left], [right]) => left - right)
      .map(([ordinal, labels]) => ({ ordinal, labels: [...labels] }))
  };
}

/** The floors a file can be put on: those found, and one either side. */
export function floorChoices(floors: ReadonlyArray<FloorFound>): number[] {
  if (floors.length === 0) return [-1, 0, 1, 2];
  const ordinals = floors.map((floor) => floor.ordinal);
  const choices = new Set([Math.min(...ordinals) - 1, ...ordinals, Math.max(...ordinals) + 1]);
  return [...choices].sort((left, right) => left - right);
}

const SHAPEFILE_PARTS = [".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix"];
const SIDECARS_REQUIRED = [".shx", ".dbf"];

export const ACCEPTED_EXTENSIONS = [...SHAPEFILE_PARTS, ".gpkg", ".zip"];

/**
 * One thing the operator thinks of as a file: a shapefile's parts together, a GeoPackage, or a zip.
 * Parts group the way the importer groups them: by the exact stem, with the extension's case ignored.
 */
export type QueuedDataset = {
  key: string;
  name: string;
  kind: "shapefile" | "gpkg" | "archive";
  /** Extensions present, for a shapefile. */
  parts: string[];
  /** Sidecars a `.shp` still lacks; the import refuses it without them. */
  missing: string[];
  /** Parts with no `.shp`, which the importer passes over. */
  skipped: boolean;
  bytes: number;
};

export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

export function isAccepted(file: File): boolean {
  return ACCEPTED_EXTENSIONS.includes(fileExtension(file.name));
}

export function datasetKey(file: File): string {
  const extension = fileExtension(file.name);
  if (SHAPEFILE_PARTS.includes(extension)) return `shp:${file.name.slice(0, -extension.length)}`;
  return `file:${file.name}`;
}

export function queuedDatasets(files: ReadonlyArray<File>): QueuedDataset[] {
  const byKey = new Map<string, QueuedDataset>();
  for (const file of files) {
    const extension = fileExtension(file.name);
    const key = datasetKey(file);
    const shapefile = key.startsWith("shp:");
    const dataset = byKey.get(key) ?? {
      key,
      name: shapefile ? file.name.slice(0, -extension.length) : file.name,
      kind: shapefile ? "shapefile" : extension === ".gpkg" ? "gpkg" : "archive",
      parts: [],
      missing: [],
      skipped: false,
      bytes: 0
    };
    if (shapefile && !dataset.parts.includes(extension)) dataset.parts.push(extension);
    dataset.bytes += file.size;
    byKey.set(key, dataset);
  }
  const datasets = [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
  for (const dataset of datasets) {
    if (dataset.kind !== "shapefile") continue;
    dataset.parts.sort();
    dataset.skipped = !dataset.parts.includes(".shp");
    dataset.missing = dataset.skipped ? [] : SIDECARS_REQUIRED.filter((part) => !dataset.parts.includes(part));
  }
  return datasets;
}

/** Adds `incoming` to `queued`; a file with the name of one already queued replaces it. */
export function addToQueue(queued: ReadonlyArray<File>, incoming: ReadonlyArray<File>): File[] {
  const names = new Set(incoming.map((file) => file.name));
  return [...queued.filter((file) => !names.has(file.name)), ...incoming];
}

/** What the bar under Bring in says, and whether its button can run. */
export type NextStep = {
  title: Bilingual;
  detail: Bilingual;
  action: Bilingual;
  /** Where the button goes: reading the queued files, or the next stage. */
  goes: "import" | "set-up" | "check";
  blocked: Bilingual | null;
};

const SET_UP_NEXT: Bilingual = {
  en: "Next: Set up — name the station, confirm the floor order and match unit codes.",
  ja: "次は設定：駅名を入力し、階の順序を確認して、ユニットのコードを対応付けます。"
};
const CHECK_NEXT: Bilingual = {
  en: "Next: Check — the files open as they are, ready to review and deliver.",
  ja: "次はチェック：ファイルをそのまま開き、確認して書き出します。"
};

function needDecision(count: number): Bilingual {
  return count === 1
    ? { en: "1 file needs a decision before you continue", ja: "続ける前に 1 件のファイルの確認が必要です" }
    : { en: `${count} files need a decision before you continue`, ja: `続ける前に ${count} 件のファイルの確認が必要です` };
}

export function queueNextStep(datasets: ReadonlyArray<QueuedDataset>, profile: ImportProfile): NextStep {
  const imdf = profile === "imdf_shapefile";
  const incomplete = datasets.filter((dataset) => dataset.missing.length > 0).length;
  const base = {
    detail: imdf
      ? CHECK_NEXT
      : { en: "Next: we read each file and guess what it holds and which floor.", ja: "次に各ファイルを読み、種類と階を推定します。" },
    action: imdf ? { en: "Import to Check", ja: "チェックへ取り込む" } : { en: "Read the files", ja: "ファイルを読み込む" },
    goes: "import" as const
  };
  if (datasets.every((dataset) => dataset.skipped)) {
    const blocked = { en: "Add at least one floor file first", ja: "フロアのファイルを 1 つ以上追加してください" };
    return { ...base, title: { en: "Add the floor files to begin", ja: "フロアのファイルを追加してください" }, blocked };
  }
  if (incomplete > 0) return { ...base, title: needDecision(incomplete), blocked: needDecision(incomplete) };
  if (imdf && datasets.some((dataset) => dataset.kind === "gpkg")) {
    const blocked = {
      en: "IMDF-schema import takes shapefiles or zip archives, not GeoPackages",
      ja: "IMDF スキーマの取り込みはシェープファイルか zip のみで、GeoPackage は使えません"
    };
    return { ...base, title: blocked, blocked };
  }
  const readable = datasets.filter((dataset) => !dataset.skipped).length;
  const title =
    readable === 1
      ? { en: "1 file ready to read", ja: "読み込めるファイル 1 件" }
      : { en: `${readable} files ready to read`, ja: `読み込めるファイル ${readable} 件` };
  return { ...base, title, blocked: null };
}

export function projectNextStep(view: BringInView, profile: ImportProfile): NextStep {
  if (profile === "imdf_shapefile") {
    return {
      title: { en: "Read as IMDF schema", ja: "IMDF スキーマとして読み込み済み" },
      detail: CHECK_NEXT,
      action: { en: "Continue to Check", ja: "チェックへ進む" },
      goes: "check",
      blocked: null
    };
  }
  const needs = view.needsYou.length;
  return {
    title: needs > 0 ? needDecision(needs) : { en: "Every file looks right", ja: "すべてのファイルに問題はありません" },
    detail: SET_UP_NEXT,
    action: { en: "Continue to Set up", ja: "設定へ進む" },
    goes: "set-up",
    blocked: needs > 0 ? needDecision(needs) : null
  };
}
