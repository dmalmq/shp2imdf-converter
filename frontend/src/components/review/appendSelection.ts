import type { AppendCandidateFeature, AppendSelection } from "../../api/client";

/**
 * Which of a staged batch's features to bring in.
 *
 * The three ways of choosing — by layer and attribute, by ticking rows, by
 * drawing a box — all edit this one state, and compose into a single rule. What
 * is computed here only ever draws the preview and the counts: the same state is
 * sent to the server declaratively and re-evaluated there, so a disagreement
 * cannot let something in that was not chosen. Keep `isSelected` in step with
 * `select_feature_ids` in `backend/src/append_importer.py`.
 */
export type LayerSelection = {
  included: boolean;
  filterColumn: string | null;
  filterValues: string[];
};

export type SelectionBase = "filters" | "picked";

export type SelectionState = {
  /**
   * Where the selection starts before the deviations apply.
   *
   * "filters" takes everything the filters match, and a click removes one —
   * right for "this whole floor except a few". "picked" starts empty and a
   * click adds — right for "just these twelve rooms", where the first reading
   * silently imports everything *but* what was chosen.
   */
  base: SelectionBase;
  layers: Record<string, LayerSelection>;
  /** null means every type. */
  featureTypes: string[] | null;
  /** Candidate level ids; null means every floor. */
  levelIds: string[] | null;
  /** Resolved IMDF categories; null means every category. */
  categories: string[] | null;
  /** WGS84 minx, miny, maxx, maxy. */
  bbox: [number, number, number, number] | null;
  excludedIds: string[];
  includedIds: string[];
};

export const EMPTY_SELECTION: SelectionState = {
  base: "filters",
  layers: {},
  featureTypes: null,
  levelIds: null,
  categories: null,
  bbox: null,
  excludedIds: [],
  includedIds: []
};

export function emptySelection(): SelectionState {
  return {
    base: "filters",
    layers: {},
    featureTypes: null,
    levelIds: null,
    categories: null,
    bbox: null,
    excludedIds: [],
    includedIds: []
  };
}

/**
 * A predicate for what the map should let you click, with the include list indexed.
 *
 * Every floor of the building is drawn at the same place, so a click lands on a
 * stack of them. Taking whichever happened to render on top meant that with a
 * floor filtered, half the clicks toggled a room on some other floor.
 *
 * This is the *view*, not the selection: picks made on one floor stay in the
 * selection when you move to the next, but they stop being drawn and stop being
 * clickable, or the floor you are working on disappears under the ones you have
 * already done. To take one back out, filter back to its floor.
 */
export function pickableMatcher(state: SelectionState): (feature: AppendCandidateFeature) => boolean {
  return (feature) => {
    if (feature.already_imported) {
      return false;
    }
    return passesFilters(feature, state);
  };
}

export function isPickable(feature: AppendCandidateFeature, state: SelectionState): boolean {
  return pickableMatcher(state)(feature);
}

function passesFilters(feature: AppendCandidateFeature, state: SelectionState): boolean {
  if (state.featureTypes !== null && !state.featureTypes.includes(feature.feature_type)) {
    return false;
  }

  if (state.levelIds !== null && !state.levelIds.includes(feature.level_id ?? "")) {
    return false;
  }

  if (state.categories !== null && !state.categories.includes(feature.category ?? "")) {
    return false;
  }

  const layer = feature.stem ? state.layers[feature.stem] : undefined;
  if (layer) {
    if (!layer.included) {
      return false;
    }
    if (layer.filterColumn) {
      const value = feature.attributes[layer.filterColumn] ?? "";
      if (!layer.filterValues.includes(value)) {
        return false;
      }
    }
  }

  if (state.bbox) {
    if (!feature.point) {
      return false;
    }
    const [minX, minY, maxX, maxY] = state.bbox;
    const [x, y] = feature.point;
    if (x < minX || x > maxX || y < minY || y > maxY) {
      return false;
    }
  }

  return true;
}

/**
 * A predicate over one selection, with the deviation lists indexed.
 *
 * Build this once per pass rather than calling `isSelected` in a loop: the two
 * lists reach one entry per feature after "select none", and scanning them as
 * arrays for each of 18,000 features is quadratic — it cost most of a second
 * per click on a full station.
 */
export function selectionMatcher(state: SelectionState): (feature: AppendCandidateFeature) => boolean {
  const included = new Set(state.includedIds);
  const excluded = new Set(state.excludedIds);
  return (feature) => {
    // A row the session already holds is never brought in twice, whatever the
    // selection says — the server skips it regardless.
    if (feature.already_imported) {
      return false;
    }
    if (included.has(feature.id)) {
      return true;
    }
    if (state.base === "picked" || excluded.has(feature.id)) {
      return false;
    }
    return passesFilters(feature, state);
  };
}

export function isSelected(feature: AppendCandidateFeature, state: SelectionState): boolean {
  return selectionMatcher(state)(feature);
}

export function selectedIds(features: AppendCandidateFeature[], state: SelectionState): string[] {
  const matches = selectionMatcher(state);
  return features.filter(matches).map((feature) => feature.id);
}

export type SelectionSummary = {
  selected: number;
  selectable: number;
  alreadyImported: number;
  /** Selected, but outside the current filters — kept, just not on screen. */
  selectedElsewhere: number;
  byType: Record<string, number>;
};

export function summarise(features: AppendCandidateFeature[], state: SelectionState): SelectionSummary {
  const byType: Record<string, number> = {};
  const matches = selectionMatcher(state);
  const canPick = pickableMatcher(state);
  let selected = 0;
  let alreadyImported = 0;
  let selectedElsewhere = 0;
  features.forEach((feature) => {
    if (feature.already_imported) {
      alreadyImported += 1;
      return;
    }
    if (matches(feature)) {
      selected += 1;
      byType[feature.feature_type] = (byType[feature.feature_type] ?? 0) + 1;
      if (!canPick(feature)) {
        selectedElsewhere += 1;
      }
    }
  });
  return {
    selected,
    selectable: features.length - alreadyImported,
    alreadyImported,
    selectedElsewhere,
    byType
  };
}

/** Flip one feature, recorded as a deviation from whatever the filters say. */
export function toggleFeature(
  state: SelectionState,
  feature: AppendCandidateFeature
): SelectionState {
  const excludedIds = state.excludedIds.filter((id) => id !== feature.id);
  const includedIds = state.includedIds.filter((id) => id !== feature.id);

  // In "picked" mode the include list *is* the membership, so a click adds or
  // removes there outright. The deviation reasoning below only makes sense when
  // the filters are what put things in.
  if (state.base === "picked") {
    return isSelected(feature, state)
      ? { ...state, excludedIds, includedIds }
      : { ...state, excludedIds, includedIds: [...includedIds, feature.id] };
  }

  if (isSelected(feature, state)) {
    // Turning it off only needs an exclusion when the filters would keep it.
    return passesFilters(feature, { ...state, excludedIds, includedIds })
      ? { ...state, excludedIds: [...excludedIds, feature.id], includedIds }
      : { ...state, excludedIds, includedIds };
  }
  return passesFilters(feature, { ...state, excludedIds, includedIds })
    ? { ...state, excludedIds, includedIds }
    : { ...state, excludedIds, includedIds: [...includedIds, feature.id] };
}

export function setAll(
  state: SelectionState,
  features: AppendCandidateFeature[],
  selected: boolean
): SelectionState {
  const canPick = pickableMatcher(state);
  const pickable = features.filter(canPick);
  if (!selected) {
    // In "picked" mode empty is the resting state, so it needs no exclusions.
    return state.base === "picked"
      ? { ...state, includedIds: [], excludedIds: [] }
      : { ...state, includedIds: [], excludedIds: pickable.map((feature) => feature.id) };
  }
  return { ...state, excludedIds: [], includedIds: pickable.map((feature) => feature.id) };
}

/** Add several features at once, as a box drawn in "picked" mode does. */
export function includeAll(state: SelectionState, features: AppendCandidateFeature[]): SelectionState {
  const already = new Set(state.includedIds);
  const excluded = new Set(state.excludedIds);
  const additions = features.filter((feature) => !already.has(feature.id)).map((feature) => feature.id);
  return {
    ...state,
    includedIds: [...state.includedIds, ...additions],
    excludedIds: state.excludedIds.filter((id) => excluded.has(id) && !additions.includes(id))
  };
}

export function valueCounts(
  features: AppendCandidateFeature[],
  stem: string,
  column: string
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  features
    .filter((feature) => feature.stem === stem && !feature.already_imported)
    .forEach((feature) => {
      const value = feature.attributes[column] ?? "";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function toRequest(state: SelectionState): AppendSelection {
  return {
    layers: Object.entries(state.layers).map(([stem, layer]) => ({
      stem,
      included: layer.included,
      filter_column: layer.filterColumn,
      filter_values: layer.filterValues
    })),
    base: state.base,
    feature_types: state.featureTypes,
    level_ids: state.levelIds,
    categories: state.categories,
    bbox: state.bbox,
    excluded_feature_ids: state.excludedIds,
    included_feature_ids: state.includedIds
  };
}

/** True when nothing has been narrowed down, so the whole batch comes in. */
export function isUnfiltered(state: SelectionState): boolean {
  // "picked" is never the whole batch, even with nothing else narrowed: sending
  // no selection at all would import everything.
  if (state.base === "picked") {
    return false;
  }
  return (
    state.featureTypes === null &&
    state.levelIds === null &&
    state.categories === null &&
    state.bbox === null &&
    state.excludedIds.length === 0 &&
    state.includedIds.length === 0 &&
    Object.values(state.layers).every((layer) => layer.included && !layer.filterColumn)
  );
}

export type Facet = { value: string; label: string; count: number };

/** Distinct values of one global axis, with how many rows each still covers. */
export function facetCounts(
  features: AppendCandidateFeature[],
  key: "level" | "category"
): Facet[] {
  const counts = new Map<string, Facet>();
  features.forEach((feature) => {
    if (feature.already_imported) {
      return;
    }
    const value = (key === "level" ? feature.level_id : feature.category) ?? "";
    const label =
      key === "level"
        ? feature.level_label || (value ? value.slice(0, 8) : "—")
        : value || "—";
    const existing = counts.get(value);
    if (existing) {
      existing.count += 1;
      return;
    }
    counts.set(value, { value, label, count: 1 });
  });
  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** Toggle one value of a facet, where null means "all of them".
 *
 * The first click narrows *to* that value rather than away from it. Starting
 * from "all", treating a click as un-ticking one of an implicit full set reads
 * backwards: picking B3F off a floor list means you want B3F, not the other
 * seven. Once something is chosen, further clicks add and remove as expected,
 * and emptying the set is the same as asking for all of them again.
 */
export function toggleFacet(current: string[] | null, all: Facet[], value: string): string[] | null {
  if (current === null) {
    return all.length === 1 ? null : [value];
  }
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  return next.length === 0 || next.length === all.length ? null : next;
}

/** Below this much travel a drag is a click, and no box is meant. */
export const MIN_BOX_PIXELS = 5;

/**
 * Whether a drag across the map was meant as a box.
 *
 * A few pixels of travel is a click. Committing one as a box leaves a filter
 * that matches nothing and draws too small to see, so the map goes blank and
 * every other control looks broken — which is exactly how it was reported.
 */
export function isDeliberateBox(from: [number, number], to: [number, number]): boolean {
  return Math.abs(to[0] - from[0]) >= MIN_BOX_PIXELS && Math.abs(to[1] - from[1]) >= MIN_BOX_PIXELS;
}

