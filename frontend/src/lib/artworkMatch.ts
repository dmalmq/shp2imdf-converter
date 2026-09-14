import type { IllustratorPageAlignment } from "../api/client";

export type FloorMatchHint = {
  label: string;
  artworkMatch?: boolean;
};

export function floorsNeedingArtworkMatch(
  floors: { label: string; pages: number[] | null }[],
  alignment: readonly IllustratorPageAlignment[]
): string[] {
  const failed = new Set(
    alignment.filter((entry) => !entry.aligned).map((entry) => entry.page)
  );
  if (failed.size === 0) return [];
  return floors
    .filter((floor) => floor.pages?.some((page) => failed.has(page)))
    .map((floor) => floor.label);
}

export function floorNumber(label: string): number | null {
  const match = label.trim().match(/^(\d+)\s*F$/i);
  return match ? Number(match[1]) : null;
}

export function preferredArtworkMatchTarget(
  activeLabel: string,
  floors: FloorMatchHint[]
): string {
  const stacked = floors
    .filter((floor) => floor.label !== activeLabel && !floor.artworkMatch)
    .map((floor) => floor.label);
  const others = floors.filter((floor) => floor.label !== activeLabel).map((floor) => floor.label);
  const pool = stacked.length > 0 ? stacked : others;
  if (pool.length === 0) return "";
  const n = floorNumber(activeLabel);
  if (n != null) {
    const lower = pool.filter((label) => {
      const value = floorNumber(label);
      return value != null && value < n;
    });
    if (lower.length > 0) {
      return lower.reduce((best, label) =>
        (floorNumber(label) ?? 0) >= (floorNumber(best) ?? 0) ? label : best
      );
    }
  }
  return pool[pool.length - 1];
}
