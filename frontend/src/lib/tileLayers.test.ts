import type { TileLayerNode } from "../api/client";
import { kindTickState, setKindTicked, tileLayerKinds } from "./tileLayers";

const node = (name: string, extra: Partial<TileLayerNode> = {}): TileLayerNode => ({
  uri: name,
  name,
  group: false,
  visible: true,
  excluded_by: null,
  draws_points: false,
  tiled_by_default: true,
  children: [],
  ...extra
});
const group = (name: string, children: TileLayerNode[], extra: Partial<TileLayerNode> = {}) =>
  node(name, { group: true, children, ...extra });

const tree = [
  group("1F", [
    node("1_Space"),
    node("1_Opening", { excluded_by: "*_opening" }),
    node("1_level", { excluded_by: "*_level" }),
    group("Facility_Merge_1", [node("toilets", { draws_points: true }), node("shops")], { excluded_by: "Facility_Merge_*" })
  ]),
  group("2F", [node("2_Space"), node("2_Opening", { excluded_by: "*_opening" })])
];

test("each pattern gathers the layers it names, through their groups too, and point layers come last", () => {
  expect(tileLayerKinds(tree)).toEqual([
    { kind: "pattern", pattern: "*_opening", layers: ["1_Opening", "2_Opening"] },
    { kind: "pattern", pattern: "*_level", layers: ["1_level"] },
    { kind: "pattern", pattern: "Facility_Merge_*", layers: ["toilets", "shops"] },
    { kind: "points", layers: ["toilets"] }
  ]);
});

test("a kind ticks and unticks all its layers and leaves the rest alone", () => {
  const [openings] = tileLayerKinds(tree);
  const everything = new Set(["1_Space", "1_Opening", "2_Space", "2_Opening", "1_level"]);

  const without = setKindTicked(everything, openings, false);

  expect([...without].sort()).toEqual(["1_Space", "1_level", "2_Space"]);
  expect(kindTickState(openings, without)).toBe(false);
  expect(kindTickState(openings, new Set(["2_Opening"]))).toBe("indeterminate");
  expect(kindTickState(openings, setKindTicked(without, openings, true))).toBe(true);
});
