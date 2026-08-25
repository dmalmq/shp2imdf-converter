import type { AppendCandidateFeature } from "../../api/client";
import {
  emptySelection,
  facetCounts,
  includeAll,
  isDeliberateBox,
  isPickable,
  selectionMatcher,
  isSelected,
  isUnfiltered,
  selectedIds,
  setAll,
  summarise,
  toRequest,
  toggleFacet,
  toggleFeature,
  valueCounts
} from "./appendSelection";


function feature(overrides: Partial<AppendCandidateFeature> & { id: string }): AppendCandidateFeature {
  return {
    feature_type: "unit",
    stem: "L_unit",
    source_row_index: 0,
    name: null,
    category: null,
    level_id: null,
    level_label: null,
    point: [139.7, 35.68],
    geometry: null,
    attributes: {},
    already_imported: false,
    ...overrides
  };
}

const SHOP_A = feature({ id: "a", name: "Shop A", attributes: { category: "B001" }, point: [139.700, 35.68] });
const SHOP_B = feature({ id: "b", name: "Shop B", attributes: { category: "B001" }, point: [139.702, 35.68] });
const STORE = feature({ id: "c", name: "Store", attributes: { category: "B019" }, point: [139.710, 35.68] });
const DOOR = feature({ id: "d", feature_type: "opening", stem: "L_opening", attributes: {}, point: [139.701, 35.68] });
const ALL = [SHOP_A, SHOP_B, STORE, DOOR];


describe("appendSelection", () => {
  it("takes everything when nothing has been narrowed down", () => {
    const state = emptySelection();
    expect(isUnfiltered(state)).toBe(true);
    expect(selectedIds(ALL, state)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps only the values ticked on an attribute filter", () => {
    const state = {
      ...emptySelection(),
      layers: { L_unit: { included: true, filterColumn: "category", filterValues: ["B001"] } }
    };
    // The filter names a column on L_unit, so the opening layer is untouched.
    expect(selectedIds(ALL, state)).toEqual(["a", "b", "d"]);
    expect(isUnfiltered(state)).toBe(false);
  });

  it("drops a whole layer when it is unticked", () => {
    const state = {
      ...emptySelection(),
      layers: { L_unit: { included: false, filterColumn: null, filterValues: [] } }
    };
    expect(selectedIds(ALL, state)).toEqual(["d"]);
  });

  it("keeps only the feature types asked for", () => {
    const state = { ...emptySelection(), featureTypes: ["unit"] };
    expect(selectedIds(ALL, state)).toEqual(["a", "b", "c"]);
  });

  it("keeps only the floors asked for", () => {
    const b1 = feature({ id: "x", level_id: "lvl-b1", level_label: "B1F" });
    const b2 = feature({ id: "y", level_id: "lvl-b2", level_label: "B2F" });
    const state = { ...emptySelection(), levelIds: ["lvl-b1"] };
    expect(selectedIds([b1, b2], state)).toEqual(["x"]);
    expect(isUnfiltered(state)).toBe(false);
  });

  it("keeps only the categories asked for", () => {
    const shop = feature({ id: "s", category: "retail" });
    const room = feature({ id: "r", category: "storage" });
    const state = { ...emptySelection(), categories: ["retail"] };
    expect(selectedIds([shop, room], state)).toEqual(["s"]);
    expect(isUnfiltered(state)).toBe(false);
  });

  it("counts each axis and turns a full set back into 'all'", () => {
    const b1 = feature({ id: "x", level_id: "lvl-b1", level_label: "B1F", category: "retail" });
    const b2a = feature({ id: "y", level_id: "lvl-b2", level_label: "B2F", category: "retail" });
    const b2b = feature({ id: "z", level_id: "lvl-b2", level_label: "B2F", category: "storage" });
    const rows = [b1, b2a, b2b];

    const floors = facetCounts(rows, "level");
    expect(floors).toEqual([
      { value: "lvl-b1", label: "B1F", count: 1 },
      { value: "lvl-b2", label: "B2F", count: 2 }
    ]);
    expect(facetCounts(rows, "category")).toEqual([
      { value: "retail", label: "retail", count: 2 },
      { value: "storage", label: "storage", count: 1 }
    ]);

    // The first click narrows to that floor rather than away from it.
    const narrowed = toggleFacet(null, floors, "lvl-b1");
    expect(narrowed).toEqual(["lvl-b1"]);
    // Adding the rest is the same as asking for all of them.
    expect(toggleFacet(narrowed, floors, "lvl-b2")).toBeNull();
    // So is emptying the set.
    expect(toggleFacet(narrowed, floors, "lvl-b1")).toBeNull();
  });

  it("keeps what falls inside a box, by representative point", () => {
    const state = { ...emptySelection(), bbox: [139.6995, 35.67, 139.7025, 35.69] as [number, number, number, number] };
    expect(selectedIds(ALL, state)).toEqual(["a", "b", "d"]);
  });

  it("leaves a feature with no point out of a box selection", () => {
    const noPoint = feature({ id: "e", point: null });
    const state = { ...emptySelection(), bbox: [139.6, 35.6, 139.8, 35.7] as [number, number, number, number] };
    expect(isSelected(noPoint, state)).toBe(false);
  });

  it("never takes a row the session already holds", () => {
    const taken = feature({ id: "f", already_imported: true });
    expect(isSelected(taken, emptySelection())).toBe(false);
    expect(summarise([...ALL, taken], emptySelection())).toMatchObject({
      selected: 4,
      selectable: 4,
      alreadyImported: 1
    });
  });

  it("records a tick as a deviation from the filters, not a rewrite of them", () => {
    const filtered = {
      ...emptySelection(),
      layers: { L_unit: { included: true, filterColumn: "category", filterValues: ["B001"] } }
    };
    // Ticking off something the filter kept becomes an exclusion.
    const withoutB = toggleFeature(filtered, SHOP_B);
    expect(withoutB.excludedIds).toEqual(["b"]);
    expect(withoutB.layers.L_unit.filterValues).toEqual(["B001"]);

    // Ticking on something the filter dropped becomes an inclusion.
    const withStore = toggleFeature(withoutB, STORE);
    expect(withStore.includedIds).toEqual(["c"]);
    expect(selectedIds(ALL, withStore)).toEqual(["a", "c", "d"]);
  });

  it("un-ticking something the filters already drop needs no exclusion", () => {
    const state = { ...emptySelection(), featureTypes: ["unit"] };
    expect(toggleFeature(state, DOOR).includedIds).toEqual(["d"]);
    // And toggling it straight back leaves no residue.
    expect(toggleFeature(toggleFeature(state, DOOR), DOOR)).toMatchObject({
      includedIds: [],
      excludedIds: []
    });
  });

  it("select-all reaches only what the filters admit", () => {
    // Not "everything": a filtered-out feature cannot be clicked either, so
    // select-all must not quietly reach past the filter into other floors.
    const filtered = { ...emptySelection(), featureTypes: ["unit"] };
    expect(selectedIds(ALL, setAll(filtered, ALL, true))).toEqual(["a", "b", "c"]);
    expect(selectedIds(ALL, setAll(filtered, ALL, false))).toEqual([]);
  });

  it("counts the values of a column, commonest first, ignoring rows already in", () => {
    const taken = feature({ id: "g", attributes: { category: "B001" }, already_imported: true });
    expect(valueCounts([...ALL, taken], "L_unit", "category")).toEqual([
      { value: "B001", count: 2 },
      { value: "B019", count: 1 }
    ]);
  });

  it("sends the state in the shape the server evaluates", () => {
    const state = {
      layers: { L_unit: { included: true, filterColumn: "category", filterValues: ["B001"] } },
      featureTypes: ["unit"],
      levelIds: ["lvl-1"],
      categories: ["retail"],
      bbox: [1, 2, 3, 4] as [number, number, number, number],
      excludedIds: ["b"],
      includedIds: ["c"]
    };
    expect(toRequest(state)).toEqual({
      layers: [{ stem: "L_unit", included: true, filter_column: "category", filter_values: ["B001"] }],
      feature_types: ["unit"],
      level_ids: ["lvl-1"],
      categories: ["retail"],
      bbox: [1, 2, 3, 4],
      excluded_feature_ids: ["b"],
      included_feature_ids: ["c"]
    });
  });
});

describe("picked mode", () => {
  it("brings in nothing until something is named", () => {
    const empty = { ...emptySelection(), base: "picked" as const };
    expect(selectedIds(ALL, empty)).toEqual([]);
    // And it is never mistaken for "no selection at all", which would send the
    // whole batch.
    expect(isUnfiltered(empty)).toBe(false);
  });

  it("brings in only what was picked, whatever the filters match", () => {
    const state = {
      ...emptySelection(),
      base: "picked" as const,
      featureTypes: ["unit"],
      includedIds: ["c"]
    };
    expect(selectedIds(ALL, state)).toEqual(["c"]);
  });

  it("still refuses to pick what the filters exclude", () => {
    const state = { ...emptySelection(), base: "picked" as const, featureTypes: ["unit"] };
    expect(isPickable(SHOP_A, state)).toBe(true);
    expect(isPickable(DOOR, state)).toBe(false);
  });

  it("adds a boxful at once and does not duplicate on overlap", () => {
    const state = { ...emptySelection(), base: "picked" as const };
    const first = includeAll(state, [SHOP_A, SHOP_B]);
    expect(selectedIds(ALL, first)).toEqual(["a", "b"]);
    const second = includeAll(first, [SHOP_B, STORE]);
    expect(second.includedIds).toEqual(["a", "b", "c"]);
  });

  it("clicking an unpicked feature brings it in", () => {
    // The filters-based branch reads "it passes the filters, so it is already
    // in" — true by default there, false here, and it made every click a no-op.
    const state = { ...emptySelection(), base: "picked" as const };
    const after = toggleFeature(state, SHOP_A);
    expect(after.includedIds).toEqual(["a"]);
    expect(selectedIds(ALL, after)).toEqual(["a"]);
  });

  it("clicking a picked feature takes it back out", () => {
    const state = { ...emptySelection(), base: "picked" as const, includedIds: ["a"] };
    expect(toggleFeature(state, SHOP_A).includedIds).toEqual([]);
    expect(selectedIds(ALL, toggleFeature(state, SHOP_A))).toEqual([]);
  });

  it("sends the base so the server starts from the same place", () => {
    expect(toRequest({ ...emptySelection(), base: "picked" }).base).toBe("picked");
    expect(toRequest(emptySelection()).base).toBe("filters");
  });
});

describe("selectionMatcher", () => {
  it("agrees with isSelected, and indexes the deviation lists", () => {
    // After "select none" the exclusion list holds one entry per feature.
    // Scanning it as an array per feature is quadratic; a full station spent
    // most of a second on every click before this was a Set.
    const many = Array.from({ length: 500 }, (_, index) => feature({ id: `f${index}` }));
    const state = setAll(emptySelection(), many, false);
    const matches = selectionMatcher(state);
    expect(many.every((item) => matches(item) === isSelected(item, state))).toBe(true);
    expect(selectedIds(many, state)).toEqual([]);

    const withOne = toggleFeature(state, many[250]);
    expect(selectedIds(many, withOne)).toEqual(["f250"]);
  });
});

describe("box drawing", () => {
  it("treats a few pixels of travel as a click, not a box", () => {
    expect(isDeliberateBox([100, 100], [102, 140])).toBe(false);
    expect(isDeliberateBox([100, 100], [140, 102])).toBe(false);
    expect(isDeliberateBox([100, 100], [100, 100])).toBe(false);
  });

  it("accepts a drag that covers ground in both directions", () => {
    expect(isDeliberateBox([100, 100], [160, 180])).toBe(true);
    // Direction does not matter; the box is normalised by the caller.
    expect(isDeliberateBox([160, 180], [100, 100])).toBe(true);
  });
});

describe("working one floor at a time", () => {
  const onB1 = feature({ id: "p", level_id: "lvl-b1", level_label: "B1F" });
  const onB2 = feature({ id: "q", level_id: "lvl-b2", level_label: "B2F" });
  const rows = [onB1, onB2];

  it("keeps picks made on another floor, but stops drawing them", () => {
    // Pick on B2, then move to B1: the pick is still coming in, but it must not
    // sit on top of the floor being worked on.
    const picked = { ...emptySelection(), base: "picked" as const, includedIds: ["q"] };
    const nowOnB1 = { ...picked, levelIds: ["lvl-b1"] };

    expect(selectedIds(rows, nowOnB1)).toEqual(["q"]);
    expect(isPickable(onB2, nowOnB1)).toBe(false);
    expect(isPickable(onB1, nowOnB1)).toBe(true);
  });

  it("says how many of the picks are off-screen", () => {
    const state = { ...emptySelection(), base: "picked" as const, includedIds: ["q"], levelIds: ["lvl-b1"] };
    expect(summarise(rows, state)).toMatchObject({ selected: 1, selectedElsewhere: 1 });
  });
});
