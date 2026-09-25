import type { ValidationResponse, WizardState } from "../../api/client";
import type { FloorGroup } from "../../components/review/floorGroups";
import type { ReviewFeature } from "../../components/review/types";
import type { CheckView, Focus } from "../check";
import type { Command, FloorRef, LevelRef } from "./types";

/** What Check holds in memory and lends to the search panel. */
export type CheckSnapshot = {
  sessionId: string;
  /** The revision `features` were read at; null until the first load. */
  contentRev: number | null;
  features: readonly ReviewFeature[];
  /** The current checks; null when they are stale or have not run. */
  validation: ValidationResponse | null;
  view: CheckView;
  floors: readonly FloorGroup[];
  language: string;
};

export type ChangeCommand = Extract<Command, { verb: "assign" | "fix" }>;

export type ApplyOutcome = { kind: "done" } | { kind: "stale" } | { kind: "failed" };

export type CheckSource = {
  snapshot: CheckSnapshot;
  openIssue: (focus: Focus) => void;
  showFloor: (label: string) => void;
  showLevel: (levelId: string) => void;
  runChecks: () => void;
  showPreview: (featureIds: readonly string[] | null) => void;
  apply: (command: ChangeCommand, basis: number) => Promise<ApplyOutcome>;
};

function texts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>)
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim());
  }
  return [];
}

function ordinalOf(feature: ReviewFeature): number {
  return typeof feature.properties.ordinal === "number" ? feature.properties.ordinal : 0;
}

export function floorRefs(features: readonly ReviewFeature[], floors: readonly FloorGroup[]): FloorRef[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  return floors.map((floor) => {
    const levels = floor.levelIds.map((id) => byId.get(id)).filter((item): item is ReviewFeature => Boolean(item));
    return {
      label: floor.label,
      ordinal: levels.length > 0 ? Math.min(...levels.map(ordinalOf)) : 0,
      levelIds: floor.levelIds,
      shortName: levels[0]?.properties.short_name ?? floor.label
    };
  });
}

export function levelRefs(features: readonly ReviewFeature[], floors: readonly FloorRef[]): LevelRef[] {
  const floorOf = new Map(floors.flatMap((floor) => floor.levelIds.map((id) => [id, floor] as const)));
  const found: LevelRef[] = [];
  for (const feature of features) {
    if (feature.feature_type !== "level") continue;
    const floor = floorOf.get(feature.id);
    if (!floor) continue;
    const names = [...new Set([...texts(feature.properties.name), ...texts(feature.properties.short_name)])];
    if (names.length === 0) continue;
    found.push({
      id: feature.id,
      name: names[0],
      names,
      floor,
      ordinal: ordinalOf(feature),
      outdoor: feature.properties.outdoor === true
    });
  }
  return found;
}

/** Floors as Set up maps them, for a project Check is not showing. */
export function wizardFloors(wizard: WizardState | null): FloorRef[] {
  const found = new Map<string, FloorRef>();
  for (const item of wizard?.levels.items ?? []) {
    const label = item.short_name?.trim() || item.name?.trim();
    if (!label || found.has(label)) continue;
    found.set(label, { label, ordinal: item.ordinal ?? 0, levelIds: [], shortName: label });
  }
  return [...found.values()].sort((a, b) => a.ordinal - b.ordinal || a.label.localeCompare(b.label));
}
