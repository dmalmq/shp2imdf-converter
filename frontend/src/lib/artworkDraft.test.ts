import type { PlacementDraft } from "../api/client";
import { resolvedTransform, type PlacementState } from "../hooks/useIllustratorPlacement";
import { stableJson } from "../hooks/useDraftAutosave";
import { fromDraft, NO_REFERENCES, toDraft, type DraftView } from "./artworkDraft";

const STATE: PlacementState = {
  frame: { rotationDeg: 12.5, metresPerPoint: 0.35277777777777775, workingCrs: "EPSG:6677" },
  activeFloorLabel: "2F",
  scaleLocked: true,
  stationPin: [139.7671, 35.6812],
  floors: [
    {
      label: "1F",
      linked: true,
      pinned: false,
      artworkAnchor: [42.5, 100],
      mapAnchor: [139.76701234567891, 35.68123456789012],
      controlPoints: [],
      artworkBounds: [0, 0, 85, 200]
    },
    {
      label: "2F",
      linked: false,
      pinned: true,
      artworkMatch: true,
      artworkAnchor: [142.5, 100],
      mapAnchor: [139.7673, 35.6814],
      rotationDeg: -3.25,
      metresPerPoint: 0.35,
      controlPoints: [
        { id: "1", artwork: [90, 10], map: [139.7672, 35.6813] },
        { id: "2", artwork: [190, 190], map: [139.7675, 35.6816] }
      ],
      artworkBounds: [85, 0, 200, 200]
    }
  ]
};

const VIEW: DraftView = {
  mode: "individual",
  tab: "export",
  outputCrs: "EPSG:4326",
  formats: { geopackage: true, shapefile: true, qgis: false },
  located: {
    kind: "chosen",
    query: "東京駅",
    place: { name: "東京駅", lngLat: [139.7671, 35.6812], workingCrs: "EPSG:6677" },
    candidates: [{ name: "東京駅", lngLat: [139.7671, 35.6812], workingCrs: "EPSG:6677" }]
  },
  references: { ...NO_REFERENCES, preloaded: true, hidden: ["Station_pl"], uploads: ["survey.zip"] }
};

test("state and view survive a round trip through the draft", () => {
  const back = fromDraft(toDraft(STATE, VIEW));
  expect(back.state).toEqual(STATE);
  expect(back.view).toEqual(VIEW);
  for (const floor of STATE.floors) {
    const restored = back.state.floors.find((item) => item.label === floor.label)!;
    expect(resolvedTransform(back.state, restored)).toEqual(resolvedTransform(STATE, floor));
  }
});

test("a draft read back from the server is the draft the page would send", () => {
  const sent = toDraft(STATE, VIEW);
  const received = JSON.parse(JSON.stringify(sent)) as PlacementDraft;
  const { state, view } = fromDraft(received);
  expect(stableJson(toDraft(state, view))).toBe(stableJson(received));
});

test("a linked floor has no own scale or rotation in the draft", () => {
  const [linked] = toDraft(STATE, VIEW).placement.floors;
  expect([linked.rotation_deg, linked.metres_per_point, linked.artwork_match]).toEqual([null, null, false]);
});

test("a located place still being looked up is not saved", () => {
  const draft = toDraft(STATE, { ...VIEW, located: { kind: "locating", query: "東京" } });
  expect(draft.view.location).toBeNull();
});

test("text past the server's bounds is clipped", () => {
  const long = "駅".repeat(400);
  const draft = toDraft(STATE, {
    ...VIEW,
    located: {
      kind: "guessed",
      query: long,
      place: { name: long, lngLat: [139, 35] },
      candidates: [{ name: long, lngLat: [139, 35] }]
    },
    references: { ...NO_REFERENCES, hidden: Array.from({ length: 80 }, (_, n) => `layer ${n}`) }
  });
  expect(draft.view.location?.query).toHaveLength(300);
  expect(draft.view.location?.place.name).toHaveLength(300);
  expect(draft.view.references.hidden).toHaveLength(64);
});

test("stableJson ignores key order", () => {
  expect(stableJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(
    stableJson({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 })
  );
});
