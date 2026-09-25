import type { Handover, HandoverEvent } from "../api/client";

export type Bilingual = { en: string; ja: string };

const SECTIONS: Record<string, Bilingual> = {
  project: { en: "Changed Project & venue", ja: "プロジェクトと施設を変更" },
  levels: { en: "Changed the level mapping", ja: "階の対応を変更" },
  buildings: { en: "Changed the buildings", ja: "建物を変更" },
  mappings: { en: "Changed the attribute mapping", ja: "属性の対応を変更" },
  footprint: { en: "Changed the footprint", ja: "フットプリントを変更" },
  company_mappings: { en: "Loaded company mappings", ja: "社内マッピングを読み込み" }
};

const FORMATS: Record<string, Bilingual> = {
  imdf: { en: "IMDF archive", ja: "IMDF アーカイブ" },
  imdf_zip: { en: "IMDF for the Sandbox", ja: "Sandbox 用 IMDF" },
  "shapefiles:odc2026": { en: "Open Data Contest 2026", ja: "オープンデータコンテスト2026" },
  qgis: { en: "QGIS project", ja: "QGIS プロジェクト" }
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace("{n}", String(n));
}

function times(n: number, line: Bilingual): Bilingual {
  if (n === 1) return line;
  return { en: `${line.en} (${n} times)`, ja: `${line.ja}（${n} 回）` };
}

/** One change-log line in both languages. */
export function eventLine(event: HandoverEvent): Bilingual {
  const { n, params } = event;
  switch (event.kind) {
    case "imported":
      if (typeof params.files === "number") {
        const files = params.files;
        return { en: plural(files, "Brought in 1 file", "Brought in {n} files"), ja: `${files} ファイルを取り込み` };
      }
      return {
        en: plural(Number(params.features ?? 0), "Imported 1 feature", "Imported {n} features"),
        ja: `${params.features ?? 0} 件のフィーチャーを取り込み`
      };
    case "files_detected":
      return times(n, { en: "Guessed the file types again", ja: "ファイルの種類を再判定" });
    case "file_changed":
      return times(n, { en: `Changed ${params.stem}`, ja: `${params.stem} を変更` });
    case "setup_changed":
      return times(n, SECTIONS[String(params.section)] ?? { en: "Changed Set up", ja: "設定を変更" });
    case "generated":
      return times(n, { en: "Generated the draft", ja: "ドラフトを生成" });
    case "features_edited":
      return { en: plural(n, "1 feature edit", "{n} feature edits"), ja: `フィーチャーの編集 ${n} 件` };
    case "features_deleted":
      return { en: plural(n, "Deleted 1 feature", "Deleted {n} features"), ja: `${n} 件のフィーチャーを削除` };
    case "units_merged":
      return times(n, { en: "Merged units", ja: "ユニットを結合" });
    case "overlaps_resolved":
      return { en: plural(n, "Resolved 1 overlap", "Resolved {n} overlaps"), ja: `${n} 件の重なりを解消` };
    case "opening_snapped":
      return {
        en: plural(n, "Snapped 1 door to its wall", "Snapped {n} doors to their walls"),
        ja: `${n} 件の開口部を壁に合わせた`
      };
    case "autofixed":
      return { en: plural(n, "Auto-fixed 1 issue", "Auto-fixed {n} issues"), ja: `${n} 件を自動修正` };
    case "fix_undone":
      return times(n, { en: "Undid a fix", ja: "修正を取り消し" });
    case "delivered": {
      const format = String(params.format);
      const name = FORMATS[format] ?? (format.startsWith("shapefiles:") ? { en: "shapefiles", ja: "シェープファイル" } : null);
      const line = name
        ? { en: `Delivered the ${name.en}`, ja: `${name.ja}を書き出し` }
        : { en: "Delivered", ja: "書き出し" };
      return times(n, line);
    }
  }
}

/** "1 h 40 min", "25 min", "under a minute". */
export function formatDuration(milliseconds: number): Bilingual {
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 1) return { en: "under a minute", ja: "1分未満" };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return { en: `${rest} min`, ja: `${rest}分` };
  if (rest === 0) return { en: `${hours} h`, ja: `${hours}時間` };
  return { en: `${hours} h ${rest} min`, ja: `${hours}時間${rest}分` };
}

const DISMISSED_KEY = "shp2imdf.welcomeBack.";

/**
 * Welcome back shows once per visit: when an earlier visit changed something
 * and this visit's Welcome back has not been dismissed in this browser.
 */
export function shouldWelcome(handover: Handover, dismissed: string | null): boolean {
  return handover.last_visit !== null && handover.visit_started_at !== null && handover.visit_started_at !== dismissed;
}

export function readDismissed(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY + sessionId);
  } catch {
    return null;
  }
}

export function writeDismissed(sessionId: string, visitStartedAt: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY + sessionId, visitStartedAt);
  } catch {
    return;
  }
}
