import type { WizardState } from "../../api/client";

export type Bilingual = { en: string; ja: string };

export type StageStatus = "done" | "current" | "todo" | "blocked";

export type Flow = "shapefiles" | "artwork" | "color-theme";

export type ShapefileStageId = "bring-in" | "set-up" | "check" | "deliver";
export type ArtworkStageId = "bring-in-artwork" | "name-floors" | "place" | "deliver";
export type ColorThemeStageId = Exclude<ShapefileStageId, "set-up">;
export type StageId = ShapefileStageId | ArtworkStageId;

/**
 * Where a stage goes when clicked. `route` is a path; `page` means the page on
 * screen registered a handler for it (the Illustrator route's Export tab). A stage with no target is not clickable.
 */
export type StageTarget = { kind: "route"; to: string } | { kind: "page" };

export type Stage = {
  id: StageId;
  label: Bilingual;
  status: StageStatus;
  detail?: Bilingual;
  /** "danger" when the detail counts things that must be fixed. */
  detailTone?: "default" | "danger";
  target?: StageTarget;
};

const SHAPEFILE_FLOW: ReadonlyArray<{ id: ShapefileStageId; label: Bilingual }> = [
  { id: "bring-in", label: { en: "Bring in", ja: "取り込み" } },
  { id: "set-up", label: { en: "Set up", ja: "設定" } },
  { id: "check", label: { en: "Check", ja: "チェック" } },
  { id: "deliver", label: { en: "Deliver", ja: "書き出し" } }
];

export const FLOW_STAGES: Record<Flow, ReadonlyArray<{ id: StageId; label: Bilingual }>> = {
  shapefiles: SHAPEFILE_FLOW,
  artwork: [
    { id: "bring-in-artwork", label: { en: "Bring in artwork", ja: "図面の取り込み" } },
    { id: "name-floors", label: { en: "Name floors", ja: "フロア名付け" } },
    { id: "place", label: { en: "Place on map", ja: "地図に配置" } },
    { id: "deliver", label: { en: "Deliver", ja: "書き出し" } }
  ],
  // The shapefile stages' own ids and labels, so the words mean the same thing in both flows.
  "color-theme": SHAPEFILE_FLOW.filter((stage) => stage.id !== "set-up")
};

/** The station colour-theme tool. */
export const COLOR_THEME_PATH = "/color-theme";

export function flowForPath(pathname: string): Flow {
  if (pathname === "/illustrator" || pathname.startsWith("/a/")) return "artwork";
  if (pathname === COLOR_THEME_PATH) return "color-theme";
  return "shapefiles";
}

/** An artwork project: the conversion id is the project. */
export function artworkPath(conversionId: string): string {
  return `/a/${encodeURIComponent(conversionId)}`;
}

/** What the page on screen has told the shell about its own stages. */
export type PageStages = {
  /** Overrides the route's stage, e.g. Deliver while the Illustrator route's Export tab is open. */
  current?: StageId | null;
  /** Stages the page can switch to itself. */
  targets?: ReadonlyArray<StageId>;
  /** Why the stage after the current one cannot be reached yet. */
  nextBlockedReason?: Bilingual | null;
  /** Errors the Check stage has found; null or undefined when not yet checked. */
  checkErrors?: number | null;
  /** Warnings the Check stage has found, which do not block delivery. */
  checkWarnings?: number | null;
  /** Files Bring in could not place on its own; null or undefined when nothing is read yet. */
  bringInNeeds?: number | null;
  /** Artwork floors whose status is Aligned, of all floors; null before floors are named. */
  floorsAligned?: { aligned: number; total: number } | null;
  /**
   * The converted artwork's page count and, once floors are named, how many there are
   * and how many pages they came from: a page marked "Not a floor plan" is read but not named.
   */
  artworkRead?: { pages: number; named: { floors: number; pages: number } | null } | null;
};

const SHAPEFILE_STAGE_IDS: ReadonlyArray<ShapefileStageId> = ["bring-in", "set-up", "check", "deliver"];

export function isShapefileStage(value: unknown): value is ShapefileStageId {
  return typeof value === "string" && (SHAPEFILE_STAGE_IDS as ReadonlyArray<string>).includes(value);
}

/** Bring in for work that is not a project yet. */
export const NEW_PROJECT_PATH = "/p/new";

export function projectPath(sessionId: string, stage: ShapefileStageId): string {
  return `/p/${encodeURIComponent(sessionId)}/${stage}`;
}

/** `/p/:sessionId` and `/p/:sessionId/:stage`; the stage is whatever the URL says, valid or not. */
export function parseProjectPath(pathname: string): { sessionId: string; stage: string | null } | null {
  const match = /^\/p\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  return { sessionId: decodeURIComponent(match[1]), stage: match[2] ?? null };
}

/** What decides which stages of a shapefile project can be opened. */
export type ShapefileProject = {
  importProfile: "standard" | "imdf_shapefile";
  /** Check has something to show (the store's `currentScreen` is "review"). */
  reviewReached: boolean;
  /** False while the project has only been brought in: Set up has saved nothing yet. */
  setUpStarted?: boolean;
};

export function stageReachable(stage: ShapefileStageId, project: ShapefileProject): boolean {
  if (stage === "bring-in") return true;
  if (stage === "set-up") return project.importProfile !== "imdf_shapefile";
  return project.reviewReached || project.importProfile === "imdf_shapefile";
}

/**
 * Where a project opens when its URL names no stage, or one it cannot reach
 * yet. Always a reachable stage, so redirecting to it cannot redirect again.
 */
export function landingStage(project: ShapefileProject): ShapefileStageId {
  if (stageReachable("check", project)) return "check";
  return project.setUpStarted === false ? "bring-in" : "set-up";
}

export type ShapefileInput = {
  pathname: string;
  sessionId: string | null;
  importProfile: "standard" | "imdf_shapefile";
  /** Review has been reached in this session (the store's `currentScreen`). */
  reviewReached: boolean;
  page?: PageStages;
};

function routeIndex(pathname: string): number {
  const stage = parseProjectPath(pathname)?.stage;
  return isShapefileStage(stage) ? SHAPEFILE_STAGE_IDS.indexOf(stage) : 0;
}

function statusFor(index: number, current: number): StageStatus {
  if (index < current) return "done";
  if (index === current) return "current";
  return "todo";
}

function pageTarget(page: PageStages | undefined, id: StageId): StageTarget | undefined {
  return page?.targets?.includes(id) ? { kind: "page" } : undefined;
}

function routeTarget(
  sessionId: string | null,
  id: ShapefileStageId,
  project: ShapefileProject
): StageTarget | undefined {
  if (id === "bring-in") return { kind: "route", to: sessionId ? projectPath(sessionId, id) : NEW_PROJECT_PATH };
  if (!sessionId || !stageReachable(id, project)) return undefined;
  return { kind: "route", to: projectPath(sessionId, id) };
}

export function shapefileStages({
  pathname,
  sessionId,
  importProfile,
  reviewReached,
  page
}: ShapefileInput): Stage[] {
  const current = page?.current
    ? Math.max(FLOW_STAGES.shapefiles.findIndex((stage) => stage.id === page.current), 0)
    : routeIndex(pathname);
  const hasSession = Boolean(sessionId);
  const setUpSkipped = importProfile === "imdf_shapefile" && hasSession;
  const project: ShapefileProject = { importProfile, reviewReached };
  const errors = page?.checkErrors;
  const needs = page?.bringInNeeds;

  return SHAPEFILE_STAGE_IDS.map((id, index) => {
    const { label } = FLOW_STAGES.shapefiles[index];
    let status = statusFor(index, current);
    const stage: Stage = { id, label, status };

    if (status !== "current") {
      // The page's own handler wins over the route.
      stage.target = pageTarget(page, id) ?? routeTarget(sessionId, id, project);
    }

    // Set up is behind you once Review has been reached, even from Bring in.
    if (id === "set-up" && status === "todo" && hasSession && reviewReached) {
      status = "done";
    }

    if (id === "set-up" && setUpSkipped) {
      stage.detail = { en: "Not needed for IMDF shapefiles", ja: "IMDF シェープファイルでは不要" };
    }

    if (id === "bring-in" && typeof needs === "number" && needs > 0) {
      stage.detail =
        needs === 1
          ? { en: "1 file needs you", ja: "確認が必要なファイル 1 件" }
          : { en: `${needs} files need you`, ja: `確認が必要なファイル ${needs} 件` };
      stage.detailTone = "danger";
    }

    if (id === "check" && typeof errors === "number") {
      const fix: Bilingual =
        errors > 0 ? { en: `${errors} to fix`, ja: `要修正 ${errors} 件` } : { en: "Nothing to fix", ja: "修正なし" };
      const waiting = page?.checkWarnings;
      stage.detail =
        typeof waiting === "number" && waiting > 0
          ? { en: `${fix.en} · ${waiting} can wait`, ja: `${fix.ja} · 後回し ${waiting} 件` }
          : fix;
      stage.detailTone = errors > 0 ? "danger" : "default";
    }

    if (id === "deliver" && status === "current") {
      stage.detail = { en: "Choose outputs", ja: "出力を選ぶ" };
    }

    if (index === current + 1 && status === "todo" && page?.nextBlockedReason && !stage.target) {
      status = "blocked";
      stage.detail = page.nextBlockedReason;
    }

    stage.status = status;
    return stage;
  });
}

/**
 * Stages of a flow that one page drives by itself: the page's current stage,
 * else `fallback` (an index); only the page's own targets are links.
 */
export function pageStages(flow: Exclude<Flow, "shapefiles">, fallback: number, page?: PageStages): Stage[] {
  const stages = FLOW_STAGES[flow];
  const current = page?.current ? Math.max(stages.findIndex((stage) => stage.id === page.current), 0) : fallback;

  const floors = flow === "artwork" ? page?.floorsAligned : null;
  const left = floors ? floors.total - floors.aligned : 0;

  return stages.map(({ id, label }, index) => {
    const stage: Stage = { id, label, status: statusFor(index, current) };
    if (stage.status !== "current") stage.target = pageTarget(page, id);
    const read = page?.artworkRead;
    if (id === "bring-in-artwork" && read) {
      stage.detail =
        read.pages === 1 ? { en: "1 page read", ja: "1 ページ読み込み済み" } : { en: `${read.pages} pages read`, ja: `${read.pages} ページ読み込み済み` };
    }
    if (id === "name-floors" && read) {
      stage.detail =
        read.named === null
          ? { en: "Say which floor each page is", ja: "各ページのフロアを指定" }
          : {
              en: `${read.named.floors} ${read.named.floors === 1 ? "floor" : "floors"} from ${read.named.pages} ${read.named.pages === 1 ? "page" : "pages"}`,
              ja: `${read.named.pages} ページから ${read.named.floors} フロア`
            };
    }
    if (id === "place" && floors) {
      stage.detail =
        left > 0
          ? {
              en: `${floors.aligned} of ${floors.total} aligned · ${left} to go`,
              ja: `${floors.total} フロア中 ${floors.aligned} 位置合わせ済み · 残り ${left}`
            }
          : { en: `${floors.aligned} of ${floors.total} aligned`, ja: `全 ${floors.total} フロア位置合わせ済み` };
    }
    if (flow === "artwork" && id === "deliver" && stage.status === "current") {
      stage.detail = { en: "Choose outputs", ja: "出力を選ぶ" };
    } else if (id === "deliver" && floors && left > 0) {
      stage.detail =
        left === 1
          ? { en: "1 floor needs alignment", ja: "位置合わせが必要なフロア 1 件" }
          : { en: `${left} floors need alignment`, ja: `位置合わせが必要なフロア ${left} 件` };
    }
    if (index === current + 1 && stage.status === "todo" && page?.nextBlockedReason && !stage.target) {
      stage.status = "blocked";
      stage.detail = page.nextBlockedReason;
    }
    return stage;
  });
}

export function currentStage(stages: Stage[]): Stage | undefined {
  return stages.find((stage) => stage.status === "current");
}

/**
 * The name shared by every uploaded file, token by token: per-floor exports
 * are named `<station>_<floor>_<layer>`, so `JRTokyoSta_B1_Space` and
 * `JRTokyoSta_1_Opening` give `JRTokyoSta`. Null when nothing is shared.
 */
export function datasetStem(stems: ReadonlyArray<string>): string | null {
  if (stems.length === 0) return null;
  if (stems.length === 1) return stems[0].trim() || null;
  const split = stems.map((stem) => stem.split(/[_\-.\s]+/).filter(Boolean));
  const shared: string[] = [];
  for (let i = 0; i < split[0].length; i += 1) {
    const token = split[0][i];
    if (!split.every((tokens) => tokens[i] === token)) break;
    shared.push(token);
  }
  return shared.length > 0 ? shared.join("_") : null;
}

/** Venue name, else project name, else the uploaded dataset's shared stem. */
export function stationName(
  wizard: Pick<WizardState, "project"> | null,
  files: ReadonlyArray<{ stem: string }>
): string | null {
  const venue = wizard?.project?.venue_name?.trim();
  if (venue) return venue;
  const project = wizard?.project?.project_name?.trim();
  if (project) return project;
  return datasetStem(files.map((file) => file.stem));
}
