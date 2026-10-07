import { readFileSync } from "node:fs";
import path from "node:path";

import type { PlacementDraft } from "../api/client";
import { templatePreview } from "../components/illustrator/PlacementLibrary";
import {
  placementReducer,
  toFloorPayloads,
  type FloorPlacement,
  type PlacementAction,
  type PlacementState,
  type ReferenceIdentity
} from "../hooks/useIllustratorPlacement";
import { fromDraft, NO_REFERENCES, toDraft } from "./artworkDraft";
import {
  alignedCount,
  floorStatus,
  recommendedAlignment,
  type CurrentReferences
} from "./floorStatus";
import { relinkPreview } from "./relinkPreview";
import type { SimilarityTransform } from "./similarity";

function floor(label: string, extra: Partial<FloorPlacement> = {}): FloorPlacement {
  return {
    label,
    linked: true,
    pinned: false,
    artworkAnchor: [100, 80],
    mapAnchor: [139.7671, 35.6812],
    controlPoints: [],
    artworkBounds: [0, 0, 200, 160],
    ...extra
  };
}

const PIN: [number, number] = [139.7671, 35.6812];

const STATE: PlacementState = {
  frame: { rotationDeg: 0, metresPerPoint: 0.176389, workingCrs: "EPSG:6677" },
  floors: [
    floor("1F"),
    floor("2F"),
    floor("3F", { linked: false, artworkMatch: true, rotationDeg: 0, metresPerPoint: 0.176389 })
  ],
  activeFloorLabel: "1F",
  scaleLocked: true,
  stationPin: PIN
};

const REFS: CurrentReferences = { preloaded: true, uploads: [], removed: [], pin: PIN };
const STATION_PG: ReferenceIdentity = { layer: "Station_pg", preloaded: true, uploads: [], pin: PIN };

const MATCH: SimilarityTransform = {
  artworkAnchor: [100, 80],
  mapAnchor: [139.768, 35.682],
  rotationDeg: 4,
  metresPerPoint: 0.176389,
  workingCrs: "EPSG:6677"
};

const run = (state: PlacementState, ...actions: PlacementAction[]) =>
  actions.reduce(placementReducer, state);

const kinds = (state: PlacementState, references: CurrentReferences = REFS) =>
  state.floors.map((f) => floorStatus(state, f, references).kind).join(",");

function fitted(): PlacementState {
  return run(
    STATE,
    { type: "addControlPoint", point: { id: "a", artwork: [0, 0], map: [139.7665, 35.6808] } },
    { type: "addControlPoint", point: { id: "b", artwork: [200, 160], map: [139.7677, 35.6816] } },
    { type: "fitControlPoints", mode: "group" }
  );
}

test("every floor starts needing alignment", () => {
  expect(kinds(STATE)).toBe("needs-alignment,needs-alignment,needs-alignment");
  expect(floorStatus(STATE, STATE.floors[0], REFS)).toEqual({ kind: "needs-alignment", reason: "never" });
});

test("a group fit aligns the linked floors it moved, and not the unstacked one", () => {
  const state = fitted();
  expect(kinds(state)).toBe("aligned,aligned,needs-alignment");
  expect(alignedCount(state, REFS)).toBe(2);
});

test("moving a floor reopens it; undoing the move by hand closes it again", () => {
  const state = fitted();
  const moved = run(state, { type: "dragFloor", label: "2F", mapAnchor: [139.769, 35.683] });
  expect(floorStatus(moved, moved.floors[1], REFS)).toEqual({ kind: "needs-alignment", reason: "moved" });
  expect(floorStatus(moved, moved.floors[0], REFS).kind).toBe("aligned");

  const rotated = run(state, { type: "rotateFrame", rotationDeg: 10 });
  expect(kinds(rotated)).toBe("needs-alignment,needs-alignment,needs-alignment");
});

test("pinning neither aligns a floor nor reopens one", () => {
  const state = fitted();
  const pinned = run(
    state,
    { type: "setFloorPinned", label: "2F", pinned: true },
    { type: "setFloorPinned", label: "3F", pinned: true }
  );
  expect(kinds(pinned)).toBe("aligned,aligned,needs-alignment");
});

test("changing the pairs a fit used reopens every floor it aligned", () => {
  const state = run(fitted(), { type: "removeControlPoint", id: "b" });
  expect(floorStatus(state, state.floors[1], REFS)).toEqual({
    kind: "needs-alignment",
    reason: "points-changed"
  });
});

test("a floor matched to another floor reopens when that floor moves", () => {
  const matched = run(
    STATE,
    { type: "setActiveFloor", label: "3F" },
    { type: "applySimilarity", mode: "individual", transform: MATCH, alignedTo: { kind: "floor", floor: "1F" } }
  );
  expect(floorStatus(matched, matched.floors[2], REFS)).toEqual({
    kind: "aligned",
    basis: expect.objectContaining({ kind: "floor", floor: "1F" })
  });
  const referenceMoved = run(matched, { type: "dragFloor", label: "1F", mapAnchor: [139.77, 35.69] });
  expect(floorStatus(referenceMoved, referenceMoved.floors[2], REFS)).toEqual({
    kind: "needs-alignment",
    reason: "reference-moved"
  });
});

describe("a floor snapped or matched to reference data", () => {
  const snapped = () =>
    run(STATE, {
      type: "applySimilarity",
      mode: "group",
      transform: MATCH,
      alignedTo: { kind: "reference", reference: STATION_PG }
    });

  test("is aligned while the same reference is loaded around the same pin", () => {
    expect(kinds(snapped())).toBe("aligned,aligned,needs-alignment");
    expect(kinds(snapped(), { ...REFS, removed: [], uploads: [] })).toBe("aligned,aligned,needs-alignment");
  });

  test("reopens when the station pin moves, even with the floors left where they are", () => {
    const moved = { ...REFS, pin: [139.768, 35.6812] as [number, number] };
    expect(floorStatus(snapped(), snapped().floors[0], moved)).toEqual({
      kind: "needs-alignment",
      reason: "reference-changed"
    });
  });

  test("reopens when the matched layer is removed, 駅データ unloaded, or another file added", () => {
    expect(kinds(snapped(), { ...REFS, removed: ["Station_pg"] })).toBe("needs-alignment,needs-alignment,needs-alignment");
    expect(kinds(snapped(), { ...REFS, preloaded: false })).toBe("needs-alignment,needs-alignment,needs-alignment");
    expect(kinds(snapped(), { ...REFS, uploads: ["extra.zip"] })).toBe("needs-alignment,needs-alignment,needs-alignment");
  });

  test("stays aligned through a draft round trip when nothing about the reference changed", () => {
    const view = {
      mode: "group" as const,
      tab: "fit" as const,
      outputCrs: "EPSG:6677",
      formats: { geopackage: false, shapefile: true, qgis: false },
      located: { kind: "none" as const },
      references: { ...NO_REFERENCES, preloaded: true }
    };
    const restored = fromDraft(JSON.parse(JSON.stringify(toDraft(snapped(), view))));
    const current: CurrentReferences = {
      preloaded: restored.view.references.preloaded,
      uploads: restored.view.references.uploads,
      removed: restored.view.references.removed,
      pin: restored.state.stationPin ?? null
    };
    expect(kinds(restored.state, current)).toBe("aligned,aligned,needs-alignment");
  });
});

test("an apply without alignedTo moves floors but aligns none", () => {
  const moved = run(STATE, { type: "applySimilarity", mode: "group", transform: MATCH });
  expect(moved.floors[0].mapAnchor).not.toEqual(STATE.floors[0].mapAnchor);
  expect(alignedCount(moved, REFS)).toBe(0);
});

test("an unstacked floor recommends matching to a stacked floor, others start with pairs", () => {
  expect(recommendedAlignment(STATE, STATE.floors[2])).toEqual({ kind: "match-floor", target: "2F" });
  expect(recommendedAlignment(STATE, STATE.floors[0])).toEqual({ kind: "points" });
});

test("the draft keeps each alignment, so a reload restores every status", () => {
  const state = run(
    fitted(),
    { type: "setActiveFloor", label: "3F" },
    { type: "applySimilarity", mode: "individual", transform: MATCH, alignedTo: { kind: "floor", floor: "1F" } }
  );
  const view = {
    mode: "group" as const,
    tab: "export" as const,
    outputCrs: "EPSG:6677",
    formats: { geopackage: false, shapefile: true, qgis: false },
    located: { kind: "not-found" as const, query: "0001_合成" },
    references: NO_REFERENCES
  };
  const restored = fromDraft(JSON.parse(JSON.stringify(toDraft(state, view))));
  expect(kinds(restored.state)).toBe("aligned,aligned,aligned");
  expect(restored.view.located).toEqual({ kind: "not-found", query: "0001_合成" });
  expect(toFloorPayloads(restored.state)).toEqual(toFloorPayloads(state));
});

// backend/tests/test_artwork_draft.py runs the same cases through floor_is_aligned.
const GOLDEN: { cases: { name: string; draft: PlacementDraft; expected: Record<string, string> }[] } =
  JSON.parse(
    readFileSync(path.resolve(process.cwd(), "../backend/tests/fixtures/floor_status_golden.json"), "utf8")
  );

test.each(GOLDEN.cases.map((c) => [c.name, c] as const))("golden fixture: %s", (_name, golden) => {
  const { state, view } = fromDraft(golden.draft);
  const current: CurrentReferences = {
    preloaded: view.references.preloaded,
    uploads: view.references.uploads,
    removed: view.references.removed,
    pin: state.stationPin ?? null
  };
  const got = Object.fromEntries(state.floors.map((f) => [f.label, floorStatus(state, f, current).kind]));
  expect(got).toEqual(golden.expected);
});

test("the relink preview names the scale, rotation and floors that would move", () => {
  const state = run(
    fitted(),
    { type: "setActiveFloor", label: "2F" },
    { type: "rotateFloor", label: "2F", rotationDeg: 30 },
    { type: "dragFloor", label: "2F", mapAnchor: [139.7700, 35.6830] }
  );
  const preview = relinkPreview(state, "2F", REFS)!;
  expect(preview.rotation).toEqual({ from: 30, to: state.frame.rotationDeg });
  expect(preview.scale.to).toBeCloseTo(preview.scale.from);
  // 2F turns about its own centre; the rest of the group jumps to follow it.
  expect(preview.moves.map((move) => move.label)).toEqual(["1F"]);
  expect(preview.reopens).toEqual(["1F"]);
  expect(relinkPreview(STATE, "1F", REFS)).toBeNull();
});

test("the template preview says which floors keep their place and which take its frame", () => {
  const state = fitted();
  const rotated = { ...toFloorPayloads(state)[0].transform, rotation_deg: 20 };
  const preview = templatePreview(
    state,
    {
      floors: [
        { label: "1F", transform: rotated },
        { label: "B1", transform: rotated }
      ],
      artwork_bounds: [0, 0, 300, 160]
    },
    [0, 0, 200, 160],
    REFS
  );
  expect(preview).toEqual({
    matched: ["1F"],
    pinned: [],
    // 3F has its own frame and stays; 2F is linked and turns with the template's frame.
    kept: ["3F"],
    reframed: ["2F"],
    unused: ["B1"],
    size: { saved: [300, 160], current: [200, 160] },
    reopens: ["1F", "2F"]
  });
});

test("the template preview lists a pinned floor the template names as left alone, not placed", () => {
  const state = run(fitted(), { type: "setFloorPinned", label: "1F", pinned: true });
  const moved = { ...toFloorPayloads(state)[0].transform, map_anchor: [139.77, 35.69] as [number, number] };
  const floors = [{ label: "1F", transform: moved }];
  const preview = templatePreview(state, { floors, artwork_bounds: [0, 0, 200, 160] }, [0, 0, 200, 160], REFS);
  expect(preview.matched).toEqual([]);
  expect(preview.pinned).toEqual(["1F"]);
  expect(preview.kept).toEqual(["2F", "3F"]);
  const after = placementReducer(state, { type: "applyFloors", floors });
  expect(after.floors[0].mapAnchor).toEqual(state.floors[0].mapAnchor);
});
