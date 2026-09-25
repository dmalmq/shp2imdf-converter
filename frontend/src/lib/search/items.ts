import type { ImportedFile, ProjectSummary, ValidationIssue } from "../../api/client";
import { featureLevelId } from "../../components/review/floorGroups";
import type { ReviewFeature } from "../../components/review/types";
import { FLOW_STAGES, projectPath, type Bilingual } from "../../components/shell/stages";
import type { UiLanguage } from "../../store/useAppStore";
import { featureLabel, type CheckGroup } from "../check";
import { issueCopy } from "../checkCopy";
import { ARTWORK_PATH, toHubProject } from "../hub";
import { termsOf } from "./match";
import { FLOOR_WORD, floorAliases, norm, splitTerm } from "./normalize";
import { canonicalFloor } from "./parse";
import type { CheckSource } from "./source";
import type { FloorRef, SearchItem } from "./types";

export type ItemsInput = {
  projects: readonly ProjectSummary[];
  /** The project the store holds, if any. */
  sessionId: string | null;
  station: string | null;
  files: readonly ImportedFile[];
  floors: readonly FloorRef[];
  check: CheckSource | null;
  uiLanguage: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
  /** The loaded project's Check at a floor. */
  floorPath: (label: string) => string | null;
  /** Where Deliver opens for the loaded project: Deliver itself, or Check while it cannot open. */
  deliverPath: string | null;
  bringInPath: string;
};

export type Items = {
  all: SearchItem[];
  nextFix: SearchItem | null;
  recents: SearchItem[];
  actions: SearchItem[];
};

const RECENTS = 3;

function day(iso: string): Bilingual {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return {
    en: new Intl.DateTimeFormat("en-GB", options).format(date),
    ja: new Intl.DateTimeFormat("ja-JP", options).format(date)
  };
}

function join(parts: Bilingual[]): Bilingual {
  return { en: parts.map((part) => part.en).join(" · "), ja: parts.map((part) => part.ja).join(" · ") };
}

function stationItems(input: ItemsInput): SearchItem[] {
  return [...input.projects]
    .sort((a, b) => Date.parse(b.last_opened) - Date.parse(a.last_opened) || a.id.localeCompare(b.id))
    .map((summary) => {
      const project = toHubProject(summary);
      const name = project.name ?? summary.id.slice(0, 8);
      const stage = FLOW_STAGES.shapefiles[project.stageNumber - 1].label;
      const status: Bilingual[] = [];
      if (project.status.kind === "to-fix") {
        status.push({ en: `${project.status.count} to fix`, ja: `要修正 ${project.status.count} 件` });
      } else if (project.status.kind === "delivered") {
        const at = day(project.status.at);
        status.push({ en: `Delivered ${at.en}`, ja: `${at.ja} 書き出し済み` });
      }
      const opened = day(summary.last_opened);
      return {
        id: `station:${summary.id}`,
        kind: "station",
        label: { en: name, ja: name },
        detail: join([stage, ...status, { en: `last opened ${opened.en}`, ja: `前回 ${opened.ja}` }]),
        hint: project.action === "open" ? { en: "Open", ja: "開く" } : { en: "Continue", ja: "続ける" },
        run: { kind: "navigate", to: project.href },
        terms: termsOf(name)
      } satisfies SearchItem;
    });
}

function issuesOnFloor(check: CheckSource | null, label: string): number {
  if (!check) return 0;
  return check.snapshot.view.mustFix
    .filter((group) => group.floors.includes(label))
    .reduce((sum, group) => sum + group.issues.length, 0);
}

function floorItems(input: ItemsInput): SearchItem[] {
  const station = input.station;
  return input.floors.map((floor) => {
    const mustFix = issuesOnFloor(input.check, floor.label);
    const label = station ? `${station} · ${floor.label}` : floor.label;
    const detail: Bilingual =
      mustFix > 0
        ? { en: `${mustFix} to fix on this floor`, ja: `このフロアの要修正 ${mustFix} 件` }
        : floor.levelIds.length > 1
          ? { en: `${floor.levelIds.length} levels`, ja: `レベル ${floor.levelIds.length} 件` }
          : { en: "Floor", ja: "フロア" };
    const to = input.check ? null : input.floorPath(floor.label);
    const check = input.check;
    return {
      id: `floor:${floor.label}`,
      kind: "floor",
      label: { en: label, ja: label },
      detail,
      hint: { en: "Open on the map", ja: "地図で開く" },
      run: check
        ? { kind: "page", invoke: () => check.showFloor(floor.label) }
        : to
          ? { kind: "navigate", to }
          : { kind: "disabled", reason: { en: "Check has not been reached yet", ja: "まだチェックに進んでいません" } },
      terms: termsOf(station, ...floorAliases(floor.label))
    } satisfies SearchItem;
  });
}

/** Issues indexed for search: must fix first, then can wait, in the rail's order. */
export const MAX_ISSUE_ITEMS = 300;

type Lookup = { byId: ReadonlyMap<string, ReviewFeature>; floorOf: ReadonlyMap<string, string>; language: string };

function issueDetail(issue: ValidationIssue, group: CheckGroup, names: Bilingual[], lookup: Lookup): Bilingual {
  const feature = issue.feature_id ? lookup.byId.get(issue.feature_id) : undefined;
  const levelId = feature ? featureLevelId(feature) : null;
  const floor = levelId ? lookup.floorOf.get(levelId) : undefined;
  const parts: Bilingual[] = [];
  if (floor) parts.push({ en: floor, ja: floor });
  if (names.length === 2) parts.push({ en: `${names[0].en} and ${names[1].en}`, ja: `${names[0].ja} と ${names[1].ja}` });
  else if (names.length === 1) parts.push(names[0]);
  parts.push(group.mustFix ? { en: "blocks delivery", ja: "書き出しを止めています" } : { en: "can wait", ja: "後回し可" });
  return join(parts);
}

function issueItems(check: CheckSource | null): SearchItem[] {
  if (!check) return [];
  const lookup: Lookup = {
    byId: new Map(check.snapshot.features.map((feature) => [feature.id, feature])),
    floorOf: new Map(check.snapshot.floors.flatMap((floor) => floor.levelIds.map((id) => [id, floor.label] as const))),
    language: check.snapshot.language
  };
  const items: SearchItem[] = [];
  for (const group of [...check.snapshot.view.mustFix, ...check.snapshot.view.canWait]) {
    const copy = issueCopy(group.check);
    for (const [index, issue] of group.issues.entries()) {
      if (items.length >= MAX_ISSUE_ITEMS) return items;
      const names = [issue.feature_id, issue.related_feature_id]
        .filter((id): id is string => Boolean(id))
        .map((id) => featureLabel(lookup.byId.get(id), lookup.language));
      items.push({
        id: `issue:${group.key}:${index}`,
        kind: "issue",
        label: copy.title,
        detail: issueDetail(issue, group, names, lookup),
        hint: { en: "Show on the map", ja: "地図で見る" },
        run: { kind: "page", invoke: () => check.openIssue({ key: group.key, index }) },
        terms: termsOf(copy.title.en, copy.title.ja, group.check.replace(/_/g, " "), ...group.floors, ...names.map((name) => name.en))
      });
    }
  }
  return items;
}

function fileItems(input: ItemsInput): SearchItem[] {
  return input.files.map((file) => {
    const name = `${file.stem}${file.source_format === "gpkg" ? ".gpkg" : ".shp"}`;
    const where = file.short_name || file.level_name;
    const type = file.detected_type ?? "";
    const detail: Bilingual = where
      ? { en: `${where}${type ? ` · ${type}` : ""}`, ja: `${where}${type ? ` · ${type}` : ""}` }
      : { en: type || "Not typed yet", ja: type || "種類が未設定" };
    return {
      id: `file:${file.stem}`,
      kind: "file",
      label: { en: name, ja: name },
      detail,
      hint: { en: "Open in Bring in", ja: "取り込みで開く" },
      run: { kind: "navigate", to: input.bringInPath },
      terms: termsOf(name, file.stem, where)
    } satisfies SearchItem;
  });
}

function actionItems(input: ItemsInput): SearchItem[] {
  const station = input.station;
  const summary = input.projects.find((project) => project.id === input.sessionId);
  const blockers = summary?.blockers ?? input.check?.snapshot.view.blockers ?? 0;
  const actions: SearchItem[] = [];
  const check = input.check;

  if (check) {
    const overlaps = [...check.snapshot.view.mustFix, ...check.snapshot.view.canWait].find(
      (group) => group.check === "overlapping_units"
    );
    if (overlaps) {
      actions.push({
        id: "action:resolve-overlap",
        kind: "action",
        label: { en: "Resolve the overlap — choose which space keeps it", ja: "重なりを解消 — どちらのスペースを残すか選ぶ" },
        detail: { en: "Keep A or keep B; the other is trimmed to fit around it", ja: "A か B を残し、もう一方を合わせて切り取ります" },
        run: { kind: "page", invoke: () => check.openIssue({ key: overlaps.key, index: 0 }) },
        terms: termsOf("resolve overlap", "重なり 解消", "overlapping units")
      });
      actions.push({
        id: "action:fix-overlaps",
        kind: "action",
        label: { en: "Trim the overlaps that have a clear answer", ja: "はっきりした重なりをまとめて解消" },
        detail: { en: "Typed as fix overlaps · shows what changes first", ja: "fix overlaps と入力 · 先に変更内容を表示" },
        run: { kind: "command", text: "fix overlaps" },
        terms: termsOf("fix overlaps", "trim overlap", "重なり")
      });
    }
    const levels = check.snapshot.floors.reduce((sum, floor) => sum + floor.levelIds.length, 0);
    actions.push({
      id: "action:run-checks",
      kind: "action",
      label: { en: "Run the checks again", ja: "もう一度チェックする" },
      detail: { en: `All ${levels} levels · takes a few seconds`, ja: `全 ${levels} レベル · 数秒かかります` },
      run: { kind: "page", invoke: () => check.runChecks() },
      terms: termsOf("run checks again", "validate", "overlap check", "check", "チェック 検証")
    });
    for (const group of [...check.snapshot.view.mustFix, ...check.snapshot.view.canWait]) {
      const copy = issueCopy(group.check);
      actions.push({
        id: `help:${group.key}`,
        kind: "action",
        tone: "help",
        label: group.mustFix
          ? { en: `Why “${copy.title.en}” blocks delivery`, ja: `「${copy.title.ja}」が書き出しを止める理由` }
          : { en: `Why “${copy.title.en}” matters`, ja: `「${copy.title.ja}」が大事な理由` },
        detail: copy.why,
        run: { kind: "page", invoke: () => check.openIssue({ key: group.key, index: 0 }) },
        terms: termsOf(copy.title.en, copy.title.ja, group.check.replace(/_/g, " "), "why help")
      });
    }
  }

  actions.push({
    id: "action:bring-in",
    kind: "action",
    label: station ? { en: "Bring in more files", ja: "ファイルを追加" } : { en: "Bring in floor shapefiles", ja: "シェープファイルを取り込む" },
    detail: station
      ? { en: `Add shapefiles to ${station} — .shp .dbf .shx .prj, .zip or .gpkg`, ja: `${station}にシェープファイルを追加 — .shp .dbf .shx .prj、.zip、.gpkg` }
      : { en: ".shp .dbf .shx .prj, .zip or .gpkg", ja: ".shp .dbf .shx .prj、.zip、.gpkg" },
    run: { kind: "navigate", to: input.bringInPath },
    terms: termsOf("bring in", "import", "add files", "upload", "取り込み", "追加")
  });
  if (station && input.deliverPath) {
    actions.push({
      id: "action:deliver",
      kind: "action",
      label: { en: `Deliver ${station}`, ja: `${station}を書き出す` },
      detail:
        blockers > 0
          ? { en: `Opens once the ${blockers} fixes are done — shows what’s left until then`, ja: `修正 ${blockers} 件の後に書き出せます — それまでは残りを表示` }
          : { en: "Choose the outputs and create them", ja: "出力を選んで作成" },
      badge: blockers > 0 ? { en: `${blockers} to fix`, ja: `要修正 ${blockers} 件` } : undefined,
      run: { kind: "navigate", to: input.deliverPath },
      terms: termsOf("deliver", "export", "download", "書き出し", "出力")
    });
  }
  const other: UiLanguage = input.uiLanguage === "ja" ? "en" : "ja";
  actions.push({
    id: "action:language",
    kind: "action",
    label: other === "ja" ? { en: "Switch to 日本語", ja: "日本語に切り替え" } : { en: "Switch to English", ja: "English に切り替え" },
    detail: { en: "Only the interface changes — your data stays as it is", ja: "画面表示だけが変わり、データはそのままです" },
    run: { kind: "page", invoke: () => input.setLanguage(other) },
    terms: termsOf("language", "english", "日本語", "japanese", "言語")
  });
  actions.push({
    id: "action:artwork",
    kind: "action",
    label: { en: "Start from Illustrator artwork", ja: "Illustrator の図面から始める" },
    detail: { en: "Place floor drawings on the map, get georeferenced shapefiles", ja: "フロア図面を地図上に配置し、座標付きシェープファイルに" },
    run: { kind: "navigate", to: ARTWORK_PATH },
    terms: termsOf("illustrator", "artwork", ".ai", ".pdf", "図面")
  });
  return actions;
}

function nextFixItem(input: ItemsInput, issues: SearchItem[]): SearchItem | null {
  const check = input.check;
  if (check) {
    const first = check.snapshot.view.mustFix[0];
    if (!first) return null;
    const item = issues.find((candidate) => candidate.id === `issue:${first.key}:0`);
    if (!item) return null;
    return {
      ...item,
      id: "next-fix",
      label: { en: `Next fix: ${item.label.en}`, ja: `次の修正：${item.label.ja}` },
      hint: { en: "Open on the map", ja: "地図で開く" }
    };
  }
  const waiting = [...input.projects]
    .filter((project) => (project.blockers ?? 0) > 0)
    .sort((a, b) => Date.parse(b.last_opened) - Date.parse(a.last_opened))[0];
  if (!waiting) return null;
  const name = waiting.name?.trim() || waiting.id.slice(0, 8);
  const n = waiting.blockers ?? 0;
  return {
    id: "next-fix",
    kind: "issue",
    label: { en: `Next fix in ${name}`, ja: `${name}の次の修正` },
    detail: {
      en: `${n} thing${n === 1 ? "" : "s"} before you can deliver`,
      ja: `書き出し前に直すことが ${n} 件`
    },
    hint: { en: "Open in Check", ja: "チェックで開く" },
    run: { kind: "navigate", to: `${projectPath(waiting.id, "check")}?issue=next` },
    terms: []
  };
}

export function buildItems(input: ItemsInput): Items {
  const stations = stationItems(input);
  const issues = issueItems(input.check);
  const actions = actionItems(input);
  return {
    all: [...stations, ...floorItems(input), ...issues, ...fileItems(input), ...actions],
    nextFix: nextFixItem(input, issues),
    recents: stations.slice(0, RECENTS),
    actions: actions.filter((item) => item.tone !== "help" && !item.id.startsWith("action:resolve"))
  };
}

/**
 * `東京駅 1F` for a station that is not loaded: its floors are unknown here,
 * so the item opens its Check at that floor and Check says if there is none.
 */
export function stationFloorItems(
  query: string,
  projects: readonly ProjectSummary[],
  loadedSessionId: string | null
): SearchItem[] {
  const terms = norm(query).split(" ").filter(Boolean).flatMap(splitTerm);
  const floorTerm = terms.find((term) => FLOOR_WORD.test(term));
  if (!floorTerm) return [];
  const floor = canonicalFloor(floorTerm);
  const others = terms.filter((term) => term !== floorTerm);
  return projects.flatMap((project) => {
    const name = project.name?.trim();
    if (!name || project.id === loadedSessionId || !others.some((term) => norm(name).includes(term))) return [];
    return [
      {
        id: `floor:${project.id}:${floor}`,
        kind: "floor",
        label: { en: `${name} · ${floor}`, ja: `${name} · ${floor}` },
        detail: { en: "Opens its Check at this floor", ja: "このフロアでチェックを開く" },
        hint: { en: "Open on the map", ja: "地図で開く" },
        run: { kind: "navigate", to: `${projectPath(project.id, "check")}?floor=${encodeURIComponent(floor)}` },
        terms: termsOf(name, ...floorAliases(floor))
      } satisfies SearchItem
    ];
  });
}
