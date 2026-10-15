import type { LayerSpecification, StyleSpecification, VectorSourceSpecification } from "maplibre-gl";

/**
 * Reading an extracted ArcGIS vector tile cache (a `.vtiles` folder) for the tile viewer.
 *
 * Every file the map asks for goes through one custom protocol, `vtiles://<path inside the folder>`,
 * so the same viewer reads a finished build on the server or a folder picked from disk.
 */

/** The tiles stored for one zoom level, as Esri lays them out: `tile/<level>/<row>/<column>.pbf`. */
export type TileLevel = { z: number; count: number; rows: [number, number]; columns: [number, number] };

export type TileIndex = { name: string; levels: TileLevel[] };

/** Where a `.vtiles` folder's files come from. `read` answers null for a file that is not there. */
export type VtilesSource = {
  index: TileIndex;
  read: (path: string, signal: AbortSignal) => Promise<ArrayBuffer | null>;
};

export const VTILES_PROTOCOL = "vtiles";
const PREFIX = `${VTILES_PROTOCOL}://`;
export const STYLE_PATH = "resources/styles/root.json";

/** Groups that stay on when one floor is shown alone. */
const BACKGROUND_GROUP = /背景|background|basemap|base map/i;
/** Floor codes such as B1, MB or RF, for layer ids like "MB/B1/<layer>" that name a floor pair. */
const FLOOR_CODE = /^(?:[FBM]\d+|MB|RF|PH\d*)$/i;
/** Nominal 1:scale at vector tile level 0, whose tiles are 512 px. */
const SCALE_Z0 = 295828763.7957775;

export function tileLevels(paths: Iterable<string>): TileLevel[] {
  const found = new Map<number, TileLevel>();
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length !== 4 || parts[0] !== "tile") continue;
    const [z, row, column] = [parts[1], parts[2], parts[3].split(".", 1)[0]];
    if (![z, row, column].every((part) => /^\d+$/.test(part))) continue;
    const [r, c] = [Number(row), Number(column)];
    const level = found.get(Number(z));
    if (!level) {
      found.set(Number(z), { z: Number(z), count: 1, rows: [r, r], columns: [c, c] });
      continue;
    }
    level.count += 1;
    level.rows = [Math.min(level.rows[0], r), Math.max(level.rows[1], r)];
    level.columns = [Math.min(level.columns[0], c), Math.max(level.columns[1], c)];
  }
  return [...found.values()].sort((a, b) => a.z - b.z);
}

/**
 * A picked folder's files by their path inside the `.vtiles` folder: whichever folder holds
 * `resources/styles/root.json`, so the operator may pick the `.vtiles` folder or the one above it.
 */
export function folderFiles(files: ReadonlyArray<{ path: string; file: File }>): { name: string; files: Map<string, File> } | null {
  const style = files.find(({ path }) => path === STYLE_PATH || path.endsWith(`/${STYLE_PATH}`));
  if (!style) return null;
  const root = style.path.slice(0, style.path.length - STYLE_PATH.length);
  const inside = new Map<string, File>();
  for (const { path, file } of files) {
    if (path.startsWith(root)) inside.set(path.slice(root.length), file);
  }
  const folder = root.replace(/\/$/, "").split("/").pop() ?? "";
  return { name: folder.replace(/\.vtiles$/i, ""), files: inside };
}

/** The ground the stored tiles cover, from the deepest level's rows and columns; null with no tiles. */
export function tileBounds(levels: ReadonlyArray<TileLevel>): [[number, number], [number, number]] | null {
  const deepest = levels[levels.length - 1];
  if (!deepest) return null;
  const n = 2 ** deepest.z;
  const lon = (column: number) => (column / n) * 360 - 180;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [
    [lon(deepest.columns[0]), lat(deepest.rows[1] + 1)],
    [lon(deepest.columns[1] + 1), lat(deepest.rows[0])]
  ];
}

/** A path inside the folder, from `relative` as written in the file at `base`; an absolute URL is kept as it is. */
export function resolvePath(base: string, relative: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return relative;
  const url = new URL(relative, `http://vtiles.invalid/${base}`);
  // Placeholders such as {z} and {fontstack} must survive for MapLibre to fill in.
  return decodeURIComponent(url.pathname.slice(1));
}

export const protocolUrl = (path: string) => (/^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `${PREFIX}${path}`);
/** MapLibre may percent-encode what it fills in, such as a font stack's spaces. */
export const protocolPath = (url: string) => decodeURIComponent(url.slice(PREFIX.length));

export type ZoomOrigin = "style" | "service" | "disk" | "default";

export type SourceInfo = {
  name: string;
  /** The tile URL template, as a path inside the folder. */
  template: string;
  minzoom: number;
  maxzoom: number;
  minFrom: ZoomOrigin;
  maxFrom: ZoomOrigin;
};

export type Problem =
  | { kind: "style-bom" }
  | { kind: "zoom-not-number"; key: "minzoom" | "maxzoom"; value: string }
  | { kind: "service-unreadable"; path: string }
  | { kind: "no-tiles-or-url"; source: string }
  | { kind: "beyond-disk"; maxzoom: number; deepest: number }
  | { kind: "tiles-missing"; first: string }
  | { kind: "glyphs-missing"; path: string }
  | { kind: "map-error"; message: string };

export type Fatal = { kind: "no-style" } | { kind: "style-not-json"; message: string } | { kind: "no-vector-source" };

export type Group = {
  name: string;
  layers: string[];
  /** Each layer's visibility as the style has it, restored when the group is switched back on. */
  visibility: Record<string, "visible" | "none">;
  background: boolean;
};

export type Prepared =
  | {
      ok: true;
      style: StyleSpecification;
      /** The first vector source, whose zoom range the status panel reports. */
      primary: SourceInfo;
      groups: Group[];
      frame: [[number, number], [number, number]] | null;
      problems: Problem[];
    }
  | { ok: false; fatal: Fatal };

type Json = Record<string, unknown>;

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The style as MapLibre can draw it from the folder: every source, sprite and glyph URL
 * rewritten to the `vtiles` protocol, and each source's zoom range settled, the style's
 * own first, then the tile service's, then the levels on disk.
 */
export async function prepareStyle(
  styleBytes: ArrayBuffer | null,
  readJson: (path: string) => Promise<Json | null>,
  index: TileIndex
): Promise<Prepared> {
  if (styleBytes === null) return { ok: false, fatal: { kind: "no-style" } };
  const bytes = new Uint8Array(styleBytes);
  const problems: Problem[] = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push({ kind: "style-bom" });
  let style: StyleSpecification;
  try {
    // TextDecoder drops the byte-order mark.
    style = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as StyleSpecification;
  } catch (caught) {
    return { ok: false, fatal: { kind: "style-not-json", message: caught instanceof Error ? caught.message : String(caught) } };
  }
  const vector = Object.entries(style.sources ?? {}).filter(
    (entry): entry is [string, VectorSourceSpecification] => (entry[1] as { type?: string })?.type === "vector"
  );
  if (vector.length === 0) return { ok: false, fatal: { kind: "no-vector-source" } };

  const levels = index.levels;
  const deepest = levels.length ? levels[levels.length - 1].z : null;
  const sources: Record<string, SourceInfo> = {};
  for (const [name, source] of vector) {
    sources[name] = await resolveSource(name, source, readJson, levels, problems);
  }
  const primary = sources[vector[0][0]];
  if (deepest !== null && primary.maxzoom > deepest) {
    problems.push({ kind: "beyond-disk", maxzoom: primary.maxzoom, deepest });
  }

  const rewritten: StyleSpecification = {
    ...style,
    sources: {
      ...style.sources,
      ...Object.fromEntries(
        vector.map(([name, source]) => {
          const info = sources[name];
          const spec: VectorSourceSpecification = {
            type: "vector",
            tiles: [protocolUrl(info.template)],
            minzoom: info.minzoom,
            maxzoom: info.maxzoom,
            scheme: source.scheme ?? "xyz"
          };
          if (Array.isArray(source.bounds) && source.bounds.length === 4) spec.bounds = source.bounds;
          return [name, spec];
        })
      )
    }
  };
  if (typeof style.sprite === "string") rewritten.sprite = protocolUrl(resolvePath(STYLE_PATH, style.sprite));
  else if (Array.isArray(style.sprite)) {
    rewritten.sprite = style.sprite.map((sprite) => ({ ...sprite, url: protocolUrl(resolvePath(STYLE_PATH, sprite.url)) }));
  }
  if (typeof style.glyphs === "string") rewritten.glyphs = protocolUrl(resolvePath(STYLE_PATH, style.glyphs));

  return { ok: true, style: rewritten, primary, groups: groupLayers(style.layers ?? []), frame: tileBounds(levels), problems };
}

async function resolveSource(
  name: string,
  source: VectorSourceSpecification,
  readJson: (path: string) => Promise<Json | null>,
  levels: ReadonlyArray<TileLevel>,
  problems: Problem[]
): Promise<SourceInfo> {
  for (const key of ["minzoom", "maxzoom"] as const) {
    if (source[key] !== undefined && finite(source[key]) === null) {
      problems.push({ kind: "zoom-not-number", key, value: JSON.stringify(source[key]) });
    }
  }
  let minzoom = finite(source.minzoom);
  let maxzoom = finite(source.maxzoom);
  let minFrom: ZoomOrigin = "style";
  let maxFrom: ZoomOrigin = "style";
  let template = "";

  if (Array.isArray(source.tiles) && source.tiles.length) {
    template = resolvePath(STYLE_PATH, source.tiles[0]);
  } else if (typeof source.url === "string") {
    const url = resolvePath(STYLE_PATH, source.url);
    const candidates = url === "" || url.endsWith("/") ? [`${url}root.json`] : [url, `${url}/root.json`];
    let service: Json | null = null;
    let servicePath = candidates[0];
    for (const candidate of candidates) {
      service = await readJson(candidate);
      if (service) {
        servicePath = candidate;
        break;
      }
    }
    if (!service) problems.push({ kind: "service-unreadable", path: candidates[0] });
    const tiles = Array.isArray(service?.tiles) && service.tiles.length ? String(service.tiles[0]) : "tile/{z}/{y}/{x}.pbf";
    template = resolvePath(servicePath, tiles);
    if (minzoom === null) {
      minzoom = finite(service?.minzoom) ?? finite(service?.minLOD);
      minFrom = "service";
    }
    if (maxzoom === null) {
      const lods = ((service?.tileInfo as Json | undefined)?.lods as Array<{ level?: unknown }> | undefined) ?? [];
      const deepestLod = lods.map((lod) => finite(lod.level)).filter((level): level is number => level !== null);
      maxzoom = finite(service?.maxzoom) ?? finite(service?.maxLOD) ?? (deepestLod.length ? Math.max(...deepestLod) : null);
      maxFrom = "service";
    }
  } else {
    problems.push({ kind: "no-tiles-or-url", source: name });
  }

  if (minzoom === null) {
    minzoom = levels.length ? levels[0].z : 0;
    minFrom = levels.length ? "disk" : "default";
  }
  if (maxzoom === null) {
    maxzoom = levels.length ? levels[levels.length - 1].z : 22;
    maxFrom = levels.length ? "disk" : "default";
  }
  return { name, template, minzoom, maxzoom, minFrom, maxFrom };
}

/** "B1/<layer>" is floor B1; "MB/B1/<layer>" is the pair; a layer id with no slash is in no group. */
export function groupOf(id: string): string {
  const parts = id.split("/");
  if (parts.length >= 3 && FLOOR_CODE.test(parts[0]) && FLOOR_CODE.test(parts[1])) return `${parts[0]}/${parts[1]}`;
  return parts.length >= 2 ? parts[0] : "";
}

/** Groups top to bottom, as the Contents pane lists them; the style lists layers bottom to top. */
export function groupLayers(layers: ReadonlyArray<LayerSpecification>): Group[] {
  const byName = new Map<string, Group>();
  for (const layer of layers) {
    const name = groupOf(layer.id);
    let group = byName.get(name);
    if (!group) {
      group = { name, layers: [], visibility: {}, background: name === "" || BACKGROUND_GROUP.test(name) };
      byName.set(name, group);
    }
    group.layers.push(layer.id);
    group.visibility[layer.id] = layer.layout?.visibility === "none" ? "none" : "visible";
  }
  return [...byName.values()].reverse();
}

/** Which groups are on with `solo` shown alone: it and the background groups. */
export function soloVisibility(groups: ReadonlyArray<Group>, solo: string): Record<string, boolean> {
  return Object.fromEntries(groups.map((group) => [group.name, group.name === solo || group.background]));
}

/** The next floor up (-1) or down (1) from `current`, skipping background groups; the first floor from none. */
export function stepFloor(groups: ReadonlyArray<Group>, current: string | null, direction: -1 | 1): string | null {
  const floors = groups.filter((group) => !group.background).map((group) => group.name);
  if (floors.length === 0) return null;
  const at = current === null ? -1 : floors.indexOf(current);
  if (at === -1) return floors[0];
  return floors[Math.min(floors.length - 1, Math.max(0, at + direction))];
}

export type DrawnFrom = { kind: "below"; minzoom: number } | { kind: "level"; z: number } | { kind: "enlarged"; z: number; factor: number };

/** Which stored level the map draws at `zoom`: none below the source's range, the deepest one enlarged above it. */
export function drawnFrom(zoom: number, source: Pick<SourceInfo, "minzoom" | "maxzoom">): DrawnFrom {
  const z = Math.floor(zoom + 1e-6);
  if (z < source.minzoom) return { kind: "below", minzoom: source.minzoom };
  if (z > source.maxzoom) return { kind: "enlarged", z: source.maxzoom, factor: 2 ** (z - source.maxzoom) };
  return { kind: "level", z };
}

export const approximateScale = (zoom: number) => Math.round(SCALE_Z0 / 2 ** zoom);

export type TileStats = {
  loaded: number;
  gzip: number;
  missing: number;
  failed: number;
  missingByLevel: Record<number, number>;
  firstMissing: string | null;
};

export const emptyTileStats: TileStats = { loaded: 0, gzip: 0, missing: 0, failed: 0, missingByLevel: {}, firstMissing: null };

export type TileResult = "loaded" | "gzip" | "missing" | "failed";

/** Requests that come back missing before any tile loads mean the folder layout does not match the template. */
const MISSING_BEFORE_ALARM = 12;

export function countTile(stats: TileStats, path: string, result: TileResult): TileStats {
  const z = /^tile\/(\d+)\//.exec(path);
  switch (result) {
    case "missing": {
      const level = z ? Number(z[1]) : null;
      return {
        ...stats,
        missing: stats.missing + 1,
        missingByLevel:
          level === null ? stats.missingByLevel : { ...stats.missingByLevel, [level]: (stats.missingByLevel[level] ?? 0) + 1 },
        firstMissing: stats.firstMissing ?? path
      };
    }
    case "failed":
      return { ...stats, failed: stats.failed + 1 };
    case "gzip":
      return { ...stats, loaded: stats.loaded + 1, gzip: stats.gzip + 1 };
    case "loaded":
      return { ...stats, loaded: stats.loaded + 1 };
  }
}

export const noTilesFound = (stats: TileStats) => stats.loaded === 0 && stats.missing >= MISSING_BEFORE_ALARM;

/** Esri may store tiles gzipped under a plain `.pbf` name; MapLibre needs them inflated. */
export async function inflate(data: ArrayBuffer): Promise<{ data: ArrayBuffer; gzip: boolean }> {
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return { data, gzip: false };
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("gzip"));
  return { data: await new Response(stream).arrayBuffer(), gzip: true };
}
