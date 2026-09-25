import type { ProjectLimits, ProjectSummary } from "../api/client";
import { FLOW_STAGES, projectPath, type ShapefileStageId, type Stage } from "../components/shell/stages";

/** What the project's card says under its track. */
export type HubStatus =
  | { kind: "delivered"; at: string }
  | { kind: "to-fix"; count: number }
  | { kind: "ready"; canWait: number }
  | { kind: "unchecked" };

/**
 * A hub card, derived from one shapefile `ProjectSummary`. Artwork projects
 * are not listed until they can be reopened by URL (phase 14).
 */
export type HubProject = {
  id: string;
  /** Null when the server has no name yet; the card falls back. */
  name: string | null;
  imdfShapefiles: boolean;
  /** 1-based position of the current stage in the four. */
  stageNumber: number;
  /** The four stages; every one is done once delivered and unchanged. */
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

function currentStageId(summary: ProjectSummary): ShapefileStageId {
  return summary.stage === "set-up" || summary.stage === "check" || summary.stage === "deliver"
    ? summary.stage
    : "bring-in";
}

/**
 * Where Continue goes. A project that has only been brought in has nothing
 * left to do on Bring in (importing there starts a new project), so it opens
 * at `/p/:id`, which lands on the first stage it can use.
 */
export function projectHref(id: string, stage: ShapefileStageId): string {
  return stage === "bring-in" ? `/p/${encodeURIComponent(id)}` : projectPath(id, stage);
}

function statusOf(summary: ProjectSummary, finished: boolean): HubStatus {
  if (finished && summary.delivered_at) return { kind: "delivered", at: summary.delivered_at };
  if (summary.blockers !== null && summary.blockers > 0) return { kind: "to-fix", count: summary.blockers };
  if (summary.blockers === 0) return { kind: "ready", canWait: summary.can_wait ?? 0 };
  return { kind: "unchecked" };
}

export function toHubProject(summary: ProjectSummary): HubProject {
  const stageId = currentStageId(summary);
  const finished = summary.delivered_at !== null && !summary.changed_since_delivery;
  const status = statusOf(summary, finished);
  const stages = FLOW_STAGES.shapefiles;
  const current = stages.findIndex((stage) => stage.id === stageId);
  const tone = status.kind === "to-fix" ? "danger" : "default";

  return {
    id: summary.id,
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
    href: projectHref(summary.id, stageId),
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
  | { route: DropRoute; files: File[]; ignored: string[] }
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

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** The end record is 22 bytes plus a comment of at most 64 KB. */
const END_SEARCH = 22 + 0xffff;

/** Entry names from a zip's central directory, or null when it has none to read. */
export async function zipEntryNames(file: Blob): Promise<string[] | null> {
  const start = Math.max(0, file.size - END_SEARCH);
  const tail = new DataView(await readBytes(file.slice(start)));
  for (let at = tail.byteLength - 22; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) !== END_OF_DIRECTORY) continue;
    const count = tail.getUint16(at + 10, true);
    const size = tail.getUint32(at + 12, true);
    const offset = tail.getUint32(at + 16, true);
    const directory = new DataView(await readBytes(file.slice(offset, offset + size)));
    const decoder = new TextDecoder();
    const names: string[] = [];
    let entry = 0;
    for (let n = 0; n < count && entry + 46 <= directory.byteLength; n += 1) {
      if (directory.getUint32(entry, true) !== DIRECTORY_ENTRY) break;
      const nameLength = directory.getUint16(entry + 28, true);
      const extraLength = directory.getUint16(entry + 30, true);
      const commentLength = directory.getUint16(entry + 32, true);
      names.push(decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + entry + 46, nameLength)));
      entry += 46 + nameLength + extraLength + commentLength;
    }
    return names;
  }
  return null;
}

/**
 * An IMDF archive has `manifest.json` at its root, or under the one folder
 * that wraps everything when it was re-zipped from its folder. A zip that
 * also holds a `.shp` is shapefiles: an IMDF archive never carries one.
 */
async function isImdfArchive(file: File): Promise<boolean> {
  if (/\.imdf\.zip$/i.test(file.name)) return true;
  const names = await zipEntryNames(file);
  if (!names || names.some((name) => /\.shp$/i.test(name))) return false;
  if (names.includes("manifest.json")) return true;
  const tops = new Set(names.map((name) => name.split("/")[0]));
  const [top] = tops;
  return tops.size === 1 && names.includes(`${top}/manifest.json`);
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
 * Files that fit none of the three routes are left behind and named in
 * `ignored`; a drop that mixes routes, or offers more than one artwork or
 * archive, is refused rather than guessed at.
 */
export async function routeDroppedFiles(files: ReadonlyArray<File>): Promise<DropDecision> {
  const routed = await Promise.all(files.map(async (file) => ({ file, route: await routeOf(file) })));
  const known = routed.filter((item): item is { file: File; route: DropRoute } => item.route !== null);
  if (known.length === 0) return { route: null, reason: "unsupported" };
  const routes = new Set(known.map((item) => item.route));
  if (routes.size > 1) return { route: null, reason: "mixed" };
  const [route] = routes;
  if (route !== "shapefiles" && known.length > 1) return { route: null, reason: "several" };
  const ignored = routed.filter((item) => item.route === null).map((item) => item.file.name);
  return { route, files: known.map((item) => item.file), ignored };
}
