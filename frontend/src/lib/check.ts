import type { FeatureUndo, ValidationIssue, ValidationResponse } from "../api/client";
import type { Bilingual } from "../components/shell/stages";
import { featureLevelId, type FloorGroup } from "../components/review/floorGroups";
import { featureName, type ReviewFeature } from "../components/review/types";
import { featureNoun } from "./checkCopy";

/** Every issue of one check. Overlaps are reported once per pair, not once per unit. */
export type CheckGroup = {
  key: string;
  check: string;
  mustFix: boolean;
  issues: ValidationIssue[];
  /** Floors the issues sit on, in floor order. */
  floors: string[];
};

/** Must fix is what blocks delivery: the validator's errors, which the hub counts as blockers. */
export type CheckView = {
  mustFix: CheckGroup[];
  canWait: CheckGroup[];
  blockers: number;
  warnings: number;
  autoFixable: number;
};

/** The issue open in the map popover: an index into one group. */
export type Focus = { key: string; index: number };

/** A fix made on this visit, with what undoes it. */
export type DoneFix = { id: number; label: Bilingual; undo: FeatureUndo };

export const EMPTY_VIEW: CheckView = { mustFix: [], canWait: [], blockers: 0, warnings: 0, autoFixable: 0 };

function floorOfIssue(
  issue: ValidationIssue,
  featuresById: ReadonlyMap<string, ReviewFeature>,
  floorByLevel: ReadonlyMap<string, string>
): string | null {
  const feature = issue.feature_id ? featuresById.get(issue.feature_id) : undefined;
  const levelId = feature ? featureLevelId(feature) : null;
  return levelId ? floorByLevel.get(levelId) ?? null : null;
}

function isRepeatOfPair(issue: ValidationIssue): boolean {
  return (
    issue.check === "overlapping_units" &&
    Boolean(issue.feature_id && issue.related_feature_id) &&
    issue.feature_id! > issue.related_feature_id!
  );
}

function groupIssues(
  issues: ValidationIssue[],
  mustFix: boolean,
  featuresById: ReadonlyMap<string, ReviewFeature>,
  floors: FloorGroup[]
): CheckGroup[] {
  const floorByLevel = new Map(floors.flatMap((floor) => floor.levelIds.map((id) => [id, floor.label] as const)));
  const floorOrder = new Map(floors.map((floor, index) => [floor.label, index]));
  const groups = new Map<string, CheckGroup>();
  for (const issue of issues) {
    if (isRepeatOfPair(issue)) continue;
    const key = `${mustFix ? "must" : "wait"}:${issue.check}`;
    const group = groups.get(key) ?? { key, check: issue.check, mustFix, issues: [], floors: [] };
    group.issues.push(issue);
    const floor = floorOfIssue(issue, featuresById, floorByLevel);
    if (floor && !group.floors.includes(floor)) group.floors.push(floor);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.floors.sort((a, b) => (floorOrder.get(a) ?? 0) - (floorOrder.get(b) ?? 0));
  }
  return [...groups.values()];
}

export function buildCheckView(
  validation: ValidationResponse | null,
  features: ReviewFeature[],
  floors: FloorGroup[]
): CheckView {
  if (!validation) return EMPTY_VIEW;
  const featuresById = new Map(features.map((feature) => [feature.id, feature]));
  return {
    mustFix: groupIssues(validation.errors, true, featuresById, floors),
    canWait: groupIssues(validation.warnings, false, featuresById, floors),
    blockers: validation.summary.error_count,
    warnings: validation.summary.warning_count,
    autoFixable: validation.summary.auto_fixable_count
  };
}

export function findGroup(view: CheckView, key: string): CheckGroup | undefined {
  return view.mustFix.find((group) => group.key === key) ?? view.canWait.find((group) => group.key === key);
}

export function focusedIssue(view: CheckView, focus: Focus | null): ValidationIssue | null {
  if (!focus) return null;
  return findGroup(view, focus.key)?.issues[focus.index] ?? null;
}

/** Keeps the popover on the same check after a revalidation; the next issue slides into the fixed one's place. */
export function refocus(view: CheckView, focus: Focus | null): Focus | null {
  if (!focus) return null;
  const group = findGroup(view, focus.key);
  if (!group || group.issues.length === 0) return null;
  const index = Math.min(focus.index, group.issues.length - 1);
  return index === focus.index ? focus : { key: focus.key, index };
}

/** Where an issue sits in the view, for opening it from somewhere else (a feature's issue list). */
export function locateIssue(view: CheckView, issue: ValidationIssue): Focus | null {
  for (const group of [...view.mustFix, ...view.canWait]) {
    const index = group.issues.findIndex(
      (candidate) =>
        candidate.check === issue.check &&
        ((candidate.feature_id === issue.feature_id && candidate.related_feature_id === issue.related_feature_id) ||
          (candidate.feature_id === issue.related_feature_id && candidate.related_feature_id === issue.feature_id))
    );
    if (index >= 0) return { key: group.key, index };
  }
  return null;
}

/** A name for a feature in running text: its own name, else its type and a short id. */
export function featureLabel(feature: ReviewFeature | undefined, language: string): Bilingual {
  if (!feature) return { en: "a missing feature", ja: "見つからないフィーチャー" };
  const name = featureName(feature, language);
  if (name) return { en: name, ja: name };
  const noun = featureNoun(feature.feature_type);
  const id = feature.id.slice(0, 8);
  return { en: `${noun.en} ${id}`, ja: `${noun.ja} ${id}` };
}

function touchedIds(undo: FeatureUndo): Set<string> {
  return new Set([...undo.remove_ids, ...undo.features.map((feature) => String(feature.id))]);
}

/** One undo for two fixes run back to back: a feature the first touched goes back to how it was before the first. */
export function composeUndo(first: FeatureUndo, second: FeatureUndo): FeatureUndo {
  const earlier = touchedIds(first);
  return {
    remove_ids: [...new Set([...first.remove_ids, ...second.remove_ids])],
    features: [...first.features, ...second.features.filter((feature) => !earlier.has(String(feature.id)))]
  };
}

/** Undo is offered only while no later fix touched the same features, so undoing cannot drop a later one. */
export function undoable(done: DoneFix[], entry: DoneFix): boolean {
  const ids = touchedIds;
  const mine = ids(entry.undo);
  return done
    .filter((other) => other.id > entry.id)
    .every((other) => ![...ids(other.undo)].some((id) => mine.has(id)));
}

type Ring = number[][];

function ringArea(ring: Ring, latitude: number): number {
  const metresPerDegree = 111_320;
  const scaleX = metresPerDegree * Math.cos((latitude * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * scaleX * ring[i + 1][1] * metresPerDegree - ring[i + 1][0] * scaleX * ring[i][1] * metresPerDegree;
  }
  return Math.abs(sum) / 2;
}

function polygons(geometry: unknown): Ring[][] {
  const shape = geometry as { type?: string; coordinates?: unknown } | null;
  if (shape?.type === "Polygon") return [shape.coordinates as Ring[]];
  if (shape?.type === "MultiPolygon") return shape.coordinates as Ring[][];
  if (shape?.type === "GeometryCollection") {
    return ((geometry as { geometries?: unknown[] }).geometries ?? []).flatMap(polygons);
  }
  return [];
}

/** Area of a lon/lat polygon in m², good to a few percent at station scale. */
export function areaSquareMetres(geometry: unknown): number {
  return polygons(geometry).reduce((total, [outer, ...holes]) => {
    if (!outer?.length) return total;
    const latitude = outer[0][1];
    return total + ringArea(outer, latitude) - holes.reduce((sum, hole) => sum + ringArea(hole, latitude), 0);
  }, 0);
}

function points(value: unknown, out: number[][]): void {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === "number" && typeof value[1] === "number") {
    out.push(value as number[]);
    return;
  }
  value.forEach((item) => points(item, out));
}

/** Middle of a geometry's bounding box, where the issue pin goes. */
export function geometryCentre(geometry: unknown): [number, number] | null {
  const shape = geometry as { coordinates?: unknown; geometries?: Array<{ coordinates?: unknown }> } | null;
  const found: number[][] = [];
  points(shape?.coordinates ?? shape?.geometries?.map((item) => item.coordinates), found);
  if (found.length === 0) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of found) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function issueAnchor(issue: ValidationIssue, featuresById: ReadonlyMap<string, ReviewFeature>): [number, number] | null {
  if (issue.overlap_geometry) return geometryCentre(issue.overlap_geometry);
  const feature = issue.feature_id ? featuresById.get(issue.feature_id) : undefined;
  return feature ? geometryCentre(feature.geometry) : null;
}
