import type { ProjectLimits, ProjectSummary } from "../api/client";
import {
  FLOW_STAGES,
  projectPath,
  type Flow,
  type Stage,
  type StageId
} from "../components/shell/stages";

/** What the project's card says under its track. */
export type HubStatus =
  | { kind: "delivered"; at: string }
  | { kind: "to-fix"; count: number }
  | { kind: "to-place"; count: number }
  | { kind: "ready"; canWait: number }
  | { kind: "unchecked" };

/** A hub card, derived from one `ProjectSummary`. */
export type HubProject = {
  id: string;
  flow: Flow;
  /** Null when the server has no name yet; the card falls back. */
  name: string | null;
  imdfShapefiles: boolean;
  /** 1-based position of the current stage in its flow's four. */
  stageNumber: number;
  /** The flow's four stages; every one is done once delivered and unchanged. */
  track: Stage[];
  status: HubStatus;
  /** When it was delivered, if it has changed since. */
  deliveredBeforeChanges: string | null;
  lastOpened: string;
  href: string;
  /** "open" for a finished project, "continue" for one with work left. */
  action: "continue" | "open";
};

export const ARTWORK_PATH = "/illustrator";

function currentStageId(summary: ProjectSummary): StageId {
  if (summary.flow === "artwork") {
    return summary.stage === "place" || summary.stage === "deliver" ? summary.stage : "name-floors";
  }
  return summary.stage === "set-up" || summary.stage === "check" || summary.stage === "deliver"
    ? summary.stage
    : "bring-in";
}

/**
 * Where Continue goes. A shapefile project that has only been brought in has
 * nothing left to do on Bring in (importing there starts a new project), so
 * it opens at `/p/:id`, which lands on the first stage it can use. Artwork has
 * one route until conversions are addressable.
 */
export function projectHref(flow: Flow, id: string, stage: StageId): string {
  if (flow === "artwork") return ARTWORK_PATH;
  if (stage === "set-up" || stage === "check" || stage === "deliver") return projectPath(id, stage);
  return `/p/${encodeURIComponent(id)}`;
}

function statusOf(summary: ProjectSummary, finished: boolean): HubStatus {
  if (finished && summary.delivered_at) return { kind: "delivered", at: summary.delivered_at };
  if (summary.blockers !== null && summary.blockers > 0) {
    return summary.flow === "artwork"
      ? { kind: "to-place", count: summary.blockers }
      : { kind: "to-fix", count: summary.blockers };
  }
  if (summary.blockers === 0) return { kind: "ready", canWait: summary.can_wait ?? 0 };
  return { kind: "unchecked" };
}

export function toHubProject(summary: ProjectSummary): HubProject {
  const stageId = currentStageId(summary);
  const finished = summary.delivered_at !== null && !summary.changed_since_delivery;
  const status = statusOf(summary, finished);
  const stages = FLOW_STAGES[summary.flow];
  const current = Math.max(
    stages.findIndex((stage) => stage.id === stageId),
    0
  );
  const tone = status.kind === "to-fix" ? "danger" : status.kind === "to-place" ? "warning" : "default";

  return {
    id: summary.id,
    flow: summary.flow,
    name: summary.name?.trim() || null,
    imdfShapefiles: summary.import_profile === "imdf_shapefile",
    stageNumber: current + 1,
    track: stages.map(({ id, label }, index) => {
      if (finished || index < current) return { id, label, status: "done" };
      if (index === current) return { id, label, status: "current", detailTone: tone };
      return { id, label, status: "todo" };
    }),
    status,
    deliveredBeforeChanges: summary.changed_since_delivery ? summary.delivered_at : null,
    lastOpened: summary.last_opened,
    href: projectHref(summary.flow, summary.id, stageId),
    action: finished ? "open" : "continue"
  };
}

/** Most recently opened first, then by id, so two equal times keep one order. */
export function hubProjects(summaries: ReadonlyArray<ProjectSummary>): HubProject[] {
  return [...summaries]
    .sort((a, b) => Date.parse(b.last_opened) - Date.parse(a.last_opened) || a.id.localeCompare(b.id))
    .map(toHubProject);
}

export type HubFilter = "all" | "in-progress" | "delivered";

export function matchesFilter(project: HubProject, filter: HubFilter): boolean {
  if (filter === "all") return true;
  return (project.action === "open") === (filter === "delivered");
}

/** Days as the hub states them: whole days, or hours under a day (a legacy 2-hour TTL). */
export function lifetime(limits: ProjectLimits): { unit: "days" | "hours"; value: number } {
  if (limits.idle_days >= 1) return { unit: "days", value: Math.round(limits.idle_days) };
  return { unit: "hours", value: Math.max(1, Math.round(limits.idle_days * 24)) };
}

/** Which "Start something new" route a set of files belongs to. */
export type DropRoute = "shapefiles" | "artwork" | "imdf";

export type DropDecision =
  | { route: DropRoute; files: File[] }
  | { route: null; reason: "unsupported" | "mixed" | "several" };

/** State handed to `/p/new` or `/illustrator` along with the navigation. */
export type DroppedFiles = { droppedFiles: File[] };

const SHAPEFILE_PARTS = new Set([".shp", ".dbf", ".shx", ".prj", ".cpg", ".qix", ".gpkg"]);
const ARTWORK = new Set([".ai", ".pdf"]);

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * A zip is either shapefiles or an IMDF archive. IMDF archives carry a
 * `manifest.json` at the root, and a zip's file names sit uncompressed in the
 * central directory at its end, so the last 64 KB is enough to tell.
 */
async function isImdfArchive(file: File): Promise<boolean> {
  if (/\.imdf\.zip$/i.test(file.name)) return true;
  const tail = new Uint8Array(await readBytes(file.slice(Math.max(0, file.size - 65536))));
  let text = "";
  for (const byte of tail) text += String.fromCharCode(byte);
  return text.includes("manifest.json") && !/\.shp/i.test(text);
}

async function routeOf(file: File): Promise<DropRoute | null> {
  const ext = extension(file.name);
  if (SHAPEFILE_PARTS.has(ext)) return "shapefiles";
  if (ARTWORK.has(ext)) return "artwork";
  if (ext === ".imdf") return "imdf";
  if (ext === ".zip") return (await isImdfArchive(file)) ? "imdf" : "shapefiles";
  return null;
}

/**
 * Files that are not one of the three routes are dropped here, as Bring in
 * would skip them; a drop that mixes routes, or offers more than one artwork
 * or archive, is refused rather than guessed at.
 */
export async function routeDroppedFiles(files: ReadonlyArray<File>): Promise<DropDecision> {
  const routed = await Promise.all(files.map(async (file) => ({ file, route: await routeOf(file) })));
  const known = routed.filter((item): item is { file: File; route: DropRoute } => item.route !== null);
  if (known.length === 0) return { route: null, reason: "unsupported" };
  const routes = new Set(known.map((item) => item.route));
  if (routes.size > 1) return { route: null, reason: "mixed" };
  const [route] = routes;
  if (route !== "shapefiles" && known.length > 1) return { route: null, reason: "several" };
  return { route, files: known.map((item) => item.file) };
}
