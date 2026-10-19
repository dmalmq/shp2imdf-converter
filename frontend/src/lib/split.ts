import type { ImportedFile, LayerGroup, SplitPreviewResponse, SplitShape } from "../api/client";
import type { Bilingual } from "../components/shell/stages";
import { floorLabel } from "./bringIn";

export type LngLat = [number, number];

/**
 * A building of the split: the corners of a drawn shape, open (the first corner is not repeated), or null
 * for none; and the files and groups picked for it. Every feature of a picked file goes to it; any other
 * feature goes to the shape holding its centre.
 */
export type Building = { key: string; name: string; corners: LngLat[] | null; files: string[]; groups: string[] };

/** Which floor each file is on; files with no floor (venue, buildings) count on every floor. */
export function floorOfStem(files: ReadonlyArray<ImportedFile>): Map<string, number | null> {
  return new Map(files.map((file) => [file.stem, file.detected_level]));
}

export type SplitFloor = { ordinal: number; label: string };

export function splitFloors(files: ReadonlyArray<ImportedFile>): SplitFloor[] {
  const labels = new Map<number, string>();
  for (const file of files) {
    if (file.detected_level === null || labels.has(file.detected_level)) continue;
    labels.set(file.detected_level, file.short_name?.trim() || floorLabel(file.detected_level));
  }
  return [...labels.entries()].sort(([a], [b]) => a - b).map(([ordinal, label]) => ({ ordinal, label }));
}

/** Whether a feature from `stem` shows while `floor` is picked (null: every floor). */
export function onFloor(stem: string | undefined, floor: number | null, floors: Map<string, number | null>): boolean {
  if (floor === null) return true;
  const own = stem === undefined ? null : floors.get(stem) ?? null;
  return own === null || own === floor;
}

/** A file-by-file count summed per floor; files with no floor go under null. */
export function countsByFloor(
  counts: Record<string, number>,
  floors: Map<string, number | null>
): Map<number | null, number> {
  const out = new Map<number | null, number>();
  for (const [stem, count] of Object.entries(counts)) {
    const floor = floors.get(stem) ?? null;
    out.set(floor, (out.get(floor) ?? 0) + count);
  }
  return out;
}

export function toPolygon(corners: ReadonlyArray<LngLat>): NonNullable<SplitShape["polygon"]> {
  return { type: "Polygon", coordinates: [[...corners, corners[0]]] };
}

/** The files a building picks, one by one or through its groups, each once. */
export function pickedStems(building: Building, groups: ReadonlyArray<LayerGroup>): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const fromGroups = building.groups.flatMap((id) => byId.get(id)?.stems ?? []);
  return [...new Set([...building.files, ...fromGroups])];
}

/** Each picked file and the buildings (by index) picking it. */
export function pickOwners(buildings: ReadonlyArray<Building>, groups: ReadonlyArray<LayerGroup>): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  buildings.forEach((building, index) => {
    for (const stem of pickedStems(building, groups)) owners.set(stem, [...(owners.get(stem) ?? []), index]);
  });
  return owners;
}

function toShape(building: Building, groups: ReadonlyArray<LayerGroup>, name: string): SplitShape {
  const files = pickedStems(building, groups);
  return {
    name,
    ...(building.corners ? { polygon: toPolygon(building.corners) } : {}),
    ...(files.length ? { files } : {})
  };
}

/**
 * What the preview is asked: the names are placeholders, so counts show while
 * a building is still unnamed or shares a name; the split itself sends the real ones.
 */
export function previewShapes(buildings: ReadonlyArray<Building>, groups: ReadonlyArray<LayerGroup>): SplitShape[] {
  return buildings.map((building, index) => toShape(building, groups, `#${index + 1}`));
}

export function splitShapes(buildings: ReadonlyArray<Building>, groups: ReadonlyArray<LayerGroup>): SplitShape[] {
  return buildings.map((building) => toShape(building, groups, building.name.trim()));
}

/** Why the preview cannot be asked yet, or null when it can: the server would refuse it for the same reason. */
export function previewBlocked(buildings: ReadonlyArray<Building>, groups: ReadonlyArray<LayerGroup>): Bilingual | null {
  if (buildings.length === 0) return { en: "Draw a building or pick its layers first.", ja: "まず建物を描くか、レイヤーを選んでください。" };
  const empty = buildings.findIndex((building) => !building.corners && pickedStems(building, groups).length === 0);
  if (empty >= 0) {
    const label = buildings[empty].name.trim() || `#${empty + 1}`;
    return {
      en: `${label} has neither a shape nor picked layers.`,
      ja: `${label} には図形も選択したレイヤーもありません。`
    };
  }
  for (const [stem, owners] of pickOwners(buildings, groups)) {
    if (owners.length < 2) continue;
    const names = owners.map((index) => buildings[index].name.trim() || `#${index + 1}`).join(", ");
    return { en: `${stem} is picked by ${names}; a file can go to one building only.`, ja: `${stem} が ${names} で重複して選択されています。ファイルは 1 つの建物にしか入れられません。` };
  }
  return null;
}

/** Why the split cannot run yet, or null when it can. */
export function splitBlocked(
  buildings: ReadonlyArray<Building>,
  groups: ReadonlyArray<LayerGroup>,
  preview: SplitPreviewResponse | null,
  previewError: string | null
): Bilingual | null {
  const local = previewBlocked(buildings, groups);
  if (local) return local;
  if (previewError) return { en: previewError, ja: previewError };
  const names = buildings.map((building) => building.name.trim());
  if (names.some((name) => !name)) return { en: "Give every building a name.", ja: "すべての建物に名前を付けてください。" };
  if (new Set(names).size !== names.length) {
    return { en: "Two buildings share a name.", ja: "同じ名前の建物があります。" };
  }
  if (!preview || preview.shapes.length !== buildings.length) return { en: "Counting…", ja: "集計中…" };
  const empty = buildings.filter((_, index) => preview.shapes[index].total === 0).map((building) => building.name.trim());
  if (empty.length) {
    const list = empty.join(", ");
    return { en: `Nothing goes to ${list}.`, ja: `${list} に入る図形がありません。` };
  }
  return null;
}

/** Files whose stem, layer or feature dataset contains `query`, ignoring case; all of them for a blank query. */
export function filterFiles(files: ReadonlyArray<ImportedFile>, query: string): ImportedFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...files];
  return files.filter((file) =>
    [file.stem, file.source_layer, file.feature_dataset].some((text) => text?.toLowerCase().includes(needle))
  );
}

export function filterGroups(groups: ReadonlyArray<LayerGroup>, query: string): LayerGroup[] {
  const needle = query.trim().toLowerCase();
  return needle ? groups.filter((group) => group.name.toLowerCase().includes(needle)) : [...groups];
}

/**
 * One colour per building, kept when others are added or removed. Every hue stays 30°
 * or more from the terracotta (about 10°) that marks what falls outside every building.
 * Mid tones, so each reads on the light map and against both themes' panels.
 */
export const BUILDING_COLOURS = ["#2563eb", "#ca8a04", "#7c3aed", "#16a34a", "#db2777", "#0891b2", "#65a30d", "#c026d3"] as const;

/** A building's colour, from the number in its key (`b1`, `b2`, …), so it never changes. */
export function buildingColour(key: string): string {
  const n = Number(/\d+/.exec(key)?.[0] ?? 1);
  return BUILDING_COLOURS[(Math.max(n, 1) - 1) % BUILDING_COLOURS.length];
}
