import type { ReviewFeature } from "./types";

/**
 * A floor and every Level feature filed under it.
 *
 * Opendata stations split one floor across several levels — 新宿 1F is eight
 * platform levels plus 1F and 1F屋外, 2F is ラチ内 / ラチ外 / 屋外 — and they all
 * carry the same short_name. Filtering the viewer by a single level id therefore
 * showed a tenth of the floor and offered ten indistinguishable "1F" options, so
 * the viewer filters by floor and shows a floor's levels together.
 */
export type FloorGroup = {
  id: string;
  label: string;
  levelIds: string[];
};

function localizedText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const found = Object.values(value as Record<string, unknown>).find((item) => typeof item === "string");
    if (typeof found === "string") {
      return found.trim() || null;
    }
  }
  return null;
}

/** Floor a level belongs to, as shown in the UI ("1F" for 「1F 15-16番線」). */
export function levelLabel(feature: ReviewFeature): string {
  return (
    localizedText(feature.properties.short_name) ??
    localizedText(feature.properties.name) ??
    (typeof feature.properties.ordinal === "number" ? `Ordinal ${feature.properties.ordinal}` : feature.id.slice(0, 8))
  );
}

function levelOrdinal(feature: ReviewFeature): number {
  return typeof feature.properties.ordinal === "number" ? feature.properties.ordinal : 0;
}

export function featureLevelId(feature: ReviewFeature): string | null {
  if (feature.feature_type === "level") {
    return feature.id;
  }
  const levelId = feature.properties.level_id;
  return typeof levelId === "string" ? levelId : null;
}

/** One entry per floor, ordered by ordinal, each holding all of its level ids. */
export function buildFloorGroups(features: ReviewFeature[]): FloorGroup[] {
  const groups = new Map<string, { label: string; ordinal: number; levelIds: string[] }>();
  for (const feature of features) {
    if (feature.feature_type !== "level") {
      continue;
    }
    const label = levelLabel(feature);
    const group = groups.get(label);
    if (group) {
      group.ordinal = Math.min(group.ordinal, levelOrdinal(feature));
      group.levelIds.push(feature.id);
      continue;
    }
    groups.set(label, { label, ordinal: levelOrdinal(feature), levelIds: [feature.id] });
  }
  return [...groups.values()]
    .sort((left, right) => left.ordinal - right.ordinal || left.label.localeCompare(right.label))
    .map((group) => ({ id: group.label, label: group.label, levelIds: group.levelIds }));
}

/** Levels the viewer should show, or null for every level. */
export function levelIdsForFloor(groups: FloorGroup[], floorId: string): string[] | null {
  if (!floorId) {
    return null;
  }
  return groups.find((group) => group.id === floorId)?.levelIds ?? [];
}

/**
 * Level choices for the editors that write `level_id`. Those need one option per
 * level, so a floor holding several of them disambiguates by level name.
 */
export function buildLevelOptions(features: ReviewFeature[]): Array<{ id: string; label: string }> {
  const levels = features
    .filter((feature) => feature.feature_type === "level")
    .sort((left, right) => levelOrdinal(left) - levelOrdinal(right));
  const perLabel = new Map<string, number>();
  for (const level of levels) {
    const label = levelLabel(level);
    perLabel.set(label, (perLabel.get(label) ?? 0) + 1);
  }
  return levels.map((level) => {
    const label = levelLabel(level);
    if ((perLabel.get(label) ?? 0) < 2) {
      return { id: level.id, label };
    }
    const name = localizedText(level.properties.name);
    if (!name || name === label) {
      return { id: level.id, label: `${label} (${level.id.slice(0, 8)})` };
    }
    return { id: level.id, label: name.startsWith(label) ? name : `${label} — ${name}` };
  });
}

/**
 * Floor the viewer should open on: the lowest one that actually holds features,
 * so a dataset whose bottom floor is an empty shell (新宿 B2 owns no units — its
 * source rows point at a B1 level) does not open on a blank map.
 */
export function defaultFloorId(groups: FloorGroup[], features: ReviewFeature[]): string | null {
  if (groups.length === 0) {
    return null;
  }
  const populated = new Set<string>();
  for (const feature of features) {
    if (feature.feature_type === "level" || !feature.geometry) {
      continue;
    }
    const levelId = featureLevelId(feature);
    if (levelId) {
      populated.add(levelId);
    }
  }
  return groups.find((group) => group.levelIds.some((id) => populated.has(id)))?.id ?? groups[0].id;
}

/** Whether a feature belongs on the shown floor. Site-wide features always do. */
export function isFeatureOnFloor(feature: ReviewFeature, levelIds: ReadonlySet<string> | null): boolean {
  if (!levelIds) {
    return true;
  }
  if (feature.feature_type === "venue" || feature.feature_type === "footprint") {
    return true;
  }
  const levelId = featureLevelId(feature);
  return levelId !== null && levelIds.has(levelId);
}
