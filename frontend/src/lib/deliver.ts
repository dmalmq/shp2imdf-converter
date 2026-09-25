import type {
  ExportContents,
  ExportFormat,
  ExportUnavailable,
  ShapefileExportEncoding,
  ShapefileExportRequest,
  ValidationSummary,
  WizardState
} from "../api/client";
import { datasetStem, type Bilingual } from "../components/shell/stages";
import type { NextStep } from "./bringIn";

type Output = {
  format: ExportFormat;
  title: Bilingual;
  note: Bilingual;
  /** Built from the uploaded shapefiles, so a GeoPackage project cannot have it. */
  fromShapefiles: boolean;
  crs: Bilingual;
  pill?: Bilingual;
};

const WGS84: Bilingual = {
  en: "IMDF in WGS 84 (EPSG:4326), as the spec requires",
  ja: "IMDF は仕様どおり WGS 84（EPSG:4326）"
};
const JGD2011: Bilingual = {
  en: "ODC files in JGD2011 (EPSG:6668), as the GSI spec asks",
  ja: "ODC ファイルは国土地理院仕様どおり JGD2011（EPSG:6668）"
};
const SOURCE_CRS: Bilingual = {
  en: "your shapefiles in their own coordinate system, unchanged",
  ja: "シェープファイルは元の座標系のまま"
};

const OUTPUTS: Record<ExportFormat, Output> = {
  imdf: {
    format: "imdf",
    title: { en: "IMDF archive", ja: "IMDF アーカイブ" },
    note: { en: "The file you hand to Apple for Indoor Maps.", ja: "Apple Indoor Maps に渡すファイルです。" },
    fromShapefiles: false,
    crs: WGS84
  },
  imdf_zip: {
    format: "imdf_zip",
    title: { en: "IMDF for the Sandbox", ja: "Sandbox 用 IMDF" },
    note: {
      en: "Same data, zipped so the IMDF Sandbox validator can check it first.",
      ja: "同じ内容を .zip にしたもの。先に IMDF Sandbox の検証にかけられます。"
    },
    fromShapefiles: false,
    crs: WGS84
  },
  odc2026_shapefiles: {
    format: "odc2026_shapefiles",
    title: { en: "Open Data Contest 2026", ja: "オープンデータコンテスト2026" },
    note: {
      en: "GSI spec: site and building, then one set of layers per floor.",
      ja: "国土地理院仕様：サイトと建物、続いてフロアごとに1セットのレイヤ。"
    },
    fromShapefiles: true,
    crs: JGD2011
  },
  qgis_project: {
    format: "qgis_project",
    title: { en: "QGIS project", ja: "QGIS プロジェクト" },
    note: {
      en: "Opens the ODC files styled, floors grouped, spaces coloured by category.",
      ja: "ODC ファイルをスタイル付きで開きます。フロアごとにまとめ、空間はカテゴリ別に色分け。"
    },
    fromShapefiles: true,
    crs: JGD2011,
    pill: { en: "Comes with the ODC 2026 files", ja: "ODC 2026 ファイル付き" }
  },
  shapefiles: {
    format: "shapefiles",
    title: { en: "Shapefiles, categories added", ja: "シェープファイル（カテゴリ付き）" },
    note: {
      en: "Your original files, with each unit’s IMDF category written back as a column.",
      ja: "元のファイルに、ユニットごとの IMDF カテゴリを列として書き戻します。"
    },
    fromShapefiles: true,
    crs: SOURCE_CRS
  }
};

const GROUPS: ReadonlyArray<{ id: string; label: Bilingual; note: Bilingual; formats: ExportFormat[] }> = [
  {
    id: "apple",
    label: { en: "For Apple", ja: "Apple 向け" },
    note: { en: "Indoor Maps and its validator", ja: "Indoor Maps とその検証" },
    formats: ["imdf", "imdf_zip"]
  },
  {
    id: "gis",
    label: { en: "For GIS and open data", ja: "GIS・オープンデータ向け" },
    note: {
      en: "GSI-spec files and a ready QGIS project",
      ja: "国土地理院仕様のファイルと、すぐ開ける QGIS プロジェクト"
    },
    formats: ["odc2026_shapefiles", "qgis_project", "shapefiles"]
  }
];

/** Every format in the order the page lists them, which is the order they are created in. */
export const FORMAT_ORDER: ReadonlyArray<ExportFormat> = GROUPS.flatMap((group) => group.formats);

const NEEDS_PREFIX = new Set<ExportFormat>(["odc2026_shapefiles", "qgis_project"]);

export type ShapefileOptions = {
  prefix: string;
  encoding: ShapefileExportEncoding;
  /** The round-trip export's category column; blank falls back to the mapped source column, then IMDF_CAT. */
  categoryField: string;
  sourceCategoryField: string;
  writeToNewField: boolean;
  legacyCodeField: string;
  legacyMapText: string;
};

/**
 * What the export options start from: the mapped unit code column, and no
 * prefix. ODC's file names are the spec's, so the operator types or confirms
 * the prefix; a fallback to the project name once named every file wrongly.
 */
export function defaultShapefileOptions(wizard: WizardState | null): ShapefileOptions {
  const sourceCategoryField = wizard?.mappings.unit.code_column?.trim() ?? "";
  const codeByCategory = new Map<string, string>();
  Object.entries(wizard?.company_mappings ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([rawCode, rawCategory]) => {
      const code = rawCode.trim();
      const category = rawCategory.trim().toLowerCase();
      if (code && category && !codeByCategory.has(category)) codeByCategory.set(category, code);
    });
  return {
    prefix: "",
    encoding: "preserve_source",
    categoryField: sourceCategoryField || "IMDF_CAT",
    sourceCategoryField,
    writeToNewField: false,
    legacyCodeField: "",
    legacyMapText: [...codeByCategory]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, code]) => `${category}=${code}`)
      .join("\n")
  };
}

function parseLegacyCodeMappings(raw: string): { mapping: Record<string, string>; invalidLines: string[] } {
  const mapping: Record<string, string> = {};
  const invalidLines: string[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/^([^=,:]+)\s*[=,:]\s*(.+)$/);
    const category = match?.[1].trim().toLowerCase();
    const code = match?.[2].trim();
    if (!category || !code) {
      invalidLines.push(`line ${index + 1}`);
      return;
    }
    mapping[category] = code;
  });
  return { mapping, invalidLines };
}

/** The body a shapefile-based export sends, or why it cannot be sent. IMDF formats send none. */
export function shapefileRequest(
  format: ExportFormat,
  options: ShapefileOptions
): { request: ShapefileExportRequest | null } | { error: Bilingual } {
  if (NEEDS_PREFIX.has(format)) {
    const exportName = options.prefix.trim();
    if (!exportName)
      return {
        error: { en: "Enter a file prefix for the ODC files.", ja: "ODC ファイルの接頭辞を入力してください。" }
      };
    return {
      request: {
        profile: "odc2026",
        mode: "source_update",
        encoding: options.encoding,
        include_report: true,
        export_name: exportName,
        unit: {
          write_imdf_category: true,
          imdf_category_field: "IMDF_CAT",
          overwrite_legacy_code_field: null,
          legacy_code_map: {}
        }
      }
    };
  }
  if (format !== "shapefiles") return { request: null };

  const sourceField = options.sourceCategoryField.trim();
  const fallback = options.writeToNewField || !sourceField ? "IMDF_CAT" : sourceField;
  const categoryField = options.categoryField.trim() || fallback;
  const legacyField = options.legacyCodeField.trim();
  let legacyMap: Record<string, string> = {};
  if (legacyField) {
    const parsed = parseLegacyCodeMappings(options.legacyMapText);
    if (parsed.invalidLines.length > 0) {
      const lines = parsed.invalidLines.join(", ");
      return {
        error: {
          en: `Legacy mappings need one category=CODE per line (${lines}).`,
          ja: `旧コードの対応は1行に1つ category=CODE の形式で入力してください（${lines}）。`
        }
      };
    }
    legacyMap = parsed.mapping;
    if (legacyField.toLowerCase() === categoryField.toLowerCase()) {
      return {
        error: {
          en: "The legacy code field must differ from the IMDF category field.",
          ja: "旧コード列は IMDF カテゴリ列と別の列にしてください。"
        }
      };
    }
  }
  return {
    request: {
      profile: "imdf_roundtrip",
      mode: "source_update",
      encoding: options.encoding,
      include_report: true,
      unit: {
        write_imdf_category: true,
        imdf_category_field: categoryField,
        overwrite_legacy_code_field: legacyField || null,
        legacy_code_map: legacyMap
      }
    }
  };
}

export function defaultSelection(importProfile: "standard" | "imdf_shapefile", geoPackage: boolean): Set<ExportFormat> {
  return new Set([importProfile === "imdf_shapefile" && !geoPackage ? "odc2026_shapefiles" : "imdf"]);
}

/** The server's reason, worded here; its own English text is shown in English only. */
const UNAVAILABLE: Record<Exclude<ExportUnavailable, "no_prefix">, (detail: string) => Bilingual> = {
  geopackage: () => ({
    en: "Not for projects brought in from GeoPackages.",
    ja: "GeoPackage から取り込んだプロジェクトでは使えません。"
  }),
  no_sources: () => ({
    en: "The uploaded shapefiles are no longer kept for this project.",
    ja: "このプロジェクトの取り込み元シェープファイルが残っていません。"
  }),
  qgis_missing: () => ({
    en: "QGIS is not installed on this PC.",
    ja: "この PC に QGIS がインストールされていません。"
  }),
  failed: (detail) => ({ en: `Can’t list this output: ${detail}`, ja: "この出力を確認できませんでした。" })
};

export type OutputCard = Output & {
  selected: boolean;
  filename: string | null;
  /** Named by the file prefix, which is still blank. */
  needsPrefix: boolean;
  /** Set when the format cannot be chosen; the card is shown, not hidden, so the reason is visible. */
  unavailable: Bilingual | null;
};

export type TreeNode = { filename: string; lines: Bilingual[] };

export type Tone = "ok" | "wait" | "danger" | "stale";

export type DeliverStatus = {
  tone: Tone;
  title: Bilingual;
  detail: Bilingual;
  action: { label: Bilingual; goes: "check" | "check-again" } | null;
};

export type DeliverView = {
  groups: Array<{ id: string; label: Bilingual; note: Bilingual; outputs: OutputCard[] }>;
  /** The chosen outputs that can be made, in creation order. */
  toCreate: ExportFormat[];
  tree: TreeNode[];
  crs: Bilingual[];
  status: DeliverStatus;
  lastChecks: Array<{ tone: Tone; text: Bilingual }>;
  showPrefix: boolean;
  /** Offered beside an empty prefix: the dataset's shared file stem. */
  suggestedPrefix: string | null;
  showEncoding: boolean;
  showFieldOptions: boolean;
  next: Omit<NextStep, "goes">;
};

export type DeliverInput = {
  selected: ReadonlySet<ExportFormat>;
  /** From the export listing; null until it has loaded. */
  contents: ReadonlyArray<ExportContents> | null;
  /** The stored validation's counts, or null when the project changed since it ran. */
  checks: Pick<ValidationSummary, "error_count" | "warning_count"> | null;
  checking: boolean;
  geoPackage: boolean;
  options: ShapefileOptions;
  /** The uploaded files' stems, whose shared start is offered as the prefix. */
  stems: ReadonlyArray<string>;
};

const SHAPEFILE_PARTS = /\.(shp|shx|dbf|prj|cpg|qix|sbn|sbx)$/i;
const FEATURE_FILE = /\.(geo)?json$/i;
const REPORT = "export_report.json";

/**
 * What an archive holds, one line per kind of file: IMDF feature files on one
 * line, shapefiles by name without their parts, and ODC's per-floor files as
 * the floors and the layers each one carries.
 */
export function treeLines(entries: ReadonlyArray<string>): Bilingual[] {
  const stems = [
    ...new Set(entries.filter((name) => SHAPEFILE_PARTS.test(name)).map((name) => name.replace(SHAPEFILE_PARTS, "")))
  ];
  const features = entries
    .filter((name) => FEATURE_FILE.test(name) && name !== REPORT)
    .map((name) => name.replace(FEATURE_FILE, ""));
  const others = entries.filter((name) => !SHAPEFILE_PARTS.test(name) && (!FEATURE_FILE.test(name) || name === REPORT));
  const same = (text: string): Bilingual => ({ en: text, ja: text });
  const lines = others.filter((name) => name !== REPORT).map(same);
  if (features.length > 0) lines.push(same(features.join(" · ")));
  lines.push(...shapefileLines(stems));
  if (others.includes(REPORT)) lines.push(same(REPORT));
  return lines;
}

function shapefileLines(stems: ReadonlyArray<string>): Bilingual[] {
  const same = (text: string): Bilingual => ({ en: text, ja: text });
  if (stems.length === 0) return [];
  const base = stems.length > 1 ? datasetStem(stems) : null;
  const rest = base ? stems.map((stem) => stem.slice(base.length)) : [];
  const perFloor = rest.map((tail) => /^_(.+)_([^_]+)$/.exec(tail));
  if (!base || !perFloor.some(Boolean)) return [same(stems.join(" · "))];
  const floors: string[] = [];
  const layers: string[] = [];
  perFloor.forEach((match) => {
    if (!match) return;
    if (!floors.includes(match[1])) floors.push(match[1]);
    if (!layers.includes(`_${match[2]}`)) layers.push(`_${match[2]}`);
  });
  const siteWide = rest.filter((_, index) => !perFloor[index]);
  return [
    ...(siteWide.length > 0 ? [same(siteWide.join(" · "))] : []),
    {
      en: `per floor ×${floors.length} (${floors.join(" · ")}): ${layers.join(" ")}`,
      ja: `フロアごと ×${floors.length}（${floors.join(" · ")}）：${layers.join(" ")}`
    }
  ];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function deliverStatus(checks: DeliverInput["checks"], checking: boolean): DeliverStatus {
  if (checks === null) {
    return checking
      ? {
          tone: "stale",
          title: { en: "Checking…", ja: "チェック中…" },
          detail: { en: "Running the checks again.", ja: "チェックをやり直しています。" },
          action: null
        }
      : {
          tone: "stale",
          title: { en: "The checks are out of date.", ja: "チェック結果が古くなっています。" },
          detail: {
            en: "Something changed since Check last ran, so what blocks delivery isn’t known yet.",
            ja: "前回のチェック以降に変更があったため、書き出しを妨げるものがあるか分かりません。"
          },
          action: { label: { en: "Check again", ja: "もう一度チェック" }, goes: "check-again" }
        };
  }
  const { error_count: errors, warning_count: warnings } = checks;
  if (errors > 0) {
    return {
      tone: "danger",
      title: {
        en: `${errors} ${plural(errors, "thing still blocks", "things still block")} delivery.`,
        ja: `書き出しを妨げる問題が ${errors} 件残っています。`
      },
      detail: {
        en: "You can still create the files, but Apple’s validator may reject the IMDF.",
        ja: "ファイルは作成できますが、Apple の検証で IMDF が却下される可能性があります。"
      },
      action: { label: { en: "Back to Check", ja: "チェックへ戻る" }, goes: "check" }
    };
  }
  return {
    tone: "ok",
    title: { en: "Nothing left that blocks delivery.", ja: "書き出しを妨げるものはありません。" },
    detail:
      warnings > 0
        ? {
            en: `${warnings} ${plural(warnings, "warning", "warnings")} can wait. They won’t stop the export, but Apple may flag them.`,
            ja: `後回しにできる警告が ${warnings} 件あります。書き出しは止めませんが、Apple に指摘される可能性があります。`
          }
        : { en: "No warnings either.", ja: "警告もありません。" },
    action: warnings > 0 ? { label: { en: "Review warnings", ja: "警告を確認" }, goes: "check" } : null
  };
}

function lastChecks(input: DeliverInput, toCreate: ReadonlyArray<ExportFormat>): DeliverView["lastChecks"] {
  const rows: DeliverView["lastChecks"] = [];
  const { checks } = input;
  if (checks === null) {
    rows.push({ tone: "stale", text: { en: "Not checked since the last change", ja: "最後の変更以降は未チェック" } });
  } else {
    rows.push(
      checks.error_count > 0
        ? {
            tone: "danger",
            text: {
              en: `${checks.error_count} to fix before delivery`,
              ja: `書き出し前に要修正 ${checks.error_count} 件`
            }
          }
        : { tone: "ok", text: { en: "Nothing to fix", ja: "修正なし" } }
    );
    if (checks.warning_count > 0) {
      rows.push({
        tone: "wait",
        text: { en: `${checks.warning_count} can wait`, ja: `後回し ${checks.warning_count} 件` }
      });
    }
  }
  const skipped = input.contents?.find((item) => item.format === "odc2026_shapefiles")?.rows_skipped.length ?? 0;
  if (skipped > 0 && toCreate.some((format) => NEEDS_PREFIX.has(format))) {
    rows.push({
      tone: "wait",
      text: {
        en: `${skipped} ${plural(skipped, "feature is", "features are")} left out of the ODC files: the shape doesn’t fit its layer`,
        ja: `${skipped} 件の地物は形状がレイヤに合わないため ODC ファイルに含まれません`
      }
    });
  }
  return rows;
}

export function buildDeliverView(input: DeliverInput): DeliverView {
  const { selected, contents, geoPackage, options } = input;
  const byFormat = new Map((contents ?? []).map((item) => [item.format, item]));

  const card = (format: ExportFormat): OutputCard => {
    const listed = byFormat.get(format);
    let unavailable: Bilingual | null = null;
    if (geoPackage && OUTPUTS[format].fromShapefiles) {
      unavailable = {
        en: "Not for projects brought in from GeoPackages.",
        ja: "GeoPackage から取り込んだプロジェクトでは使えません。"
      };
    } else if (listed?.reason && listed.reason !== "no_prefix") {
      unavailable = UNAVAILABLE[listed.reason](listed.unavailable ?? "");
    }
    const needsPrefix = NEEDS_PREFIX.has(format) && !options.prefix.trim();
    return {
      ...OUTPUTS[format],
      selected: selected.has(format) && !unavailable,
      filename: needsPrefix ? null : (listed?.filename ?? null),
      needsPrefix,
      unavailable
    };
  };

  const groups = GROUPS.map((group) => ({ ...group, outputs: group.formats.map(card) }));
  const cards = groups.flatMap((group) => group.outputs);
  const chosen = cards.filter((output) => output.selected);
  const toCreate = chosen.map((output) => output.format);

  const suggestion = datasetStem(input.stems);
  const tree = chosen.flatMap((output) => {
    const listed = byFormat.get(output.format);
    return output.filename && listed ? [{ filename: output.filename, lines: treeLines(listed.entries) }] : [];
  });
  const crs = [...new Set(chosen.map((output) => output.crs))];

  const blocked =
    toCreate.length === 0
      ? { en: "Pick at least one output.", ja: "出力を1つ以上選んでください。" }
      : (toCreate.map((format) => shapefileRequest(format, options)).find((result) => "error" in result)?.error ??
        null);
  const count = toCreate.length;
  const next: DeliverView["next"] = {
    title:
      count === 0
        ? { en: "Nothing chosen yet", ja: "まだ何も選ばれていません" }
        : {
            en: `Downloads ${count} ${plural(count, "file", "files")}`,
            ja: `${count} 個のファイルをダウンロードします`
          },
    detail: {
      en: "You can come back and export again at any time — nothing in the project changes.",
      ja: "いつでも戻って書き出し直せます。プロジェクトの内容は変わりません。"
    },
    action:
      count > 1
        ? { en: `Create ${count} outputs`, ja: `${count} 件の出力を作成` }
        : { en: "Create the output", ja: "出力を作成" },
    blocked
  };

  return {
    groups,
    toCreate,
    tree,
    crs,
    status: deliverStatus(input.checks, input.checking),
    lastChecks: lastChecks(input, toCreate),
    showPrefix: toCreate.some((format) => NEEDS_PREFIX.has(format)),
    suggestedPrefix: suggestion && suggestion !== options.prefix.trim() ? suggestion : null,
    showEncoding: chosen.some((output) => output.fromShapefiles),
    showFieldOptions: toCreate.includes("shapefiles"),
    next
  };
}
