import type { ImportedFile, SplitPreviewResponse, SplitShape } from "../api/client";
import type { Bilingual } from "../components/shell/stages";
import { floorLabel } from "./bringIn";

export type LngLat = [number, number];

/** A building as drawn: its corners, open (the first corner is not repeated). */
export type DrawnBuilding = { key: string; name: string; corners: LngLat[] };

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

export function toPolygon(corners: ReadonlyArray<LngLat>): SplitShape["polygon"] {
  return { type: "Polygon", coordinates: [[...corners, corners[0]]] };
}

/**
 * What the preview is asked: the names are placeholders, so counts show while
 * a building is still unnamed or shares a name; the split itself sends the real ones.
 */
export function previewShapes(buildings: ReadonlyArray<DrawnBuilding>): SplitShape[] {
  return buildings.map((building, index) => ({ name: `#${index + 1}`, polygon: toPolygon(building.corners) }));
}

export function splitShapes(buildings: ReadonlyArray<DrawnBuilding>): SplitShape[] {
  return buildings.map((building) => ({ name: building.name.trim(), polygon: toPolygon(building.corners) }));
}

/** Why the split cannot run yet, or null when it can. */
export function splitBlocked(
  buildings: ReadonlyArray<DrawnBuilding>,
  preview: SplitPreviewResponse | null,
  previewError: string | null
): Bilingual | null {
  if (buildings.length === 0) return { en: "Draw a building first.", ja: "まず建物を描いてください。" };
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
    return { en: `Nothing falls inside ${list}.`, ja: `${list} の中に図形がありません。` };
  }
  return null;
}
