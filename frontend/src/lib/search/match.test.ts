import { describe, expect, it } from "vitest";

import { search, termsOf } from "./match";
import type { SearchItem, SearchKind } from "./types";

const item = (id: string, kind: SearchKind, ...terms: string[]): SearchItem => ({
  id,
  kind,
  label: { en: id, ja: id },
  detail: { en: "", ja: "" },
  run: { kind: "disabled", reason: { en: "", ja: "" } },
  terms: termsOf(...terms)
});

const ITEMS = [
  item("station:tokyo", "station", "東京駅"),
  item("station:shinjuku", "station", "新宿駅"),
  item("floor:1F", "floor", "東京駅", "1F", "1階"),
  item("floor:2F", "floor", "東京駅", "2F", "2階"),
  item("issue:overlap", "issue", "Two spaces overlap", "overlapping units", "1F"),
  item("file:opening", "file", "JRTokyoSta_1_Opening.shp", "1F"),
  item("file:space", "file", "JRTokyoSta_1_Space.shp", "1F"),
  item("action:deliver", "action", "deliver", "export"),
  item("action:checks", "action", "run checks again", "overlap check")
];

const ids = (query: string) => search(ITEMS, query).groups.map((group) => [group.kind, group.items.map((entry) => entry.id)]);

describe("search", () => {
  it("puts the floor that covers both words above the station that covers one (119:193)", () => {
    expect(ids("東京駅 1F")).toEqual([
      ["floor", ["floor:1F", "floor:2F"]],
      ["station", ["station:tokyo"]],
      ["issue", ["issue:overlap"]],
      ["file", ["file:opening", "file:space"]]
    ]);
  });

  it("splits a term typed without a space where the scripts meet", () => {
    expect(ids("東京駅1階")[0]).toEqual(["floor", ["floor:1F", "floor:2F"]]);
  });

  it("finds the issue first for overlap, and names the groups with nothing (117:273)", () => {
    const result = search(ITEMS, "overlap");
    expect(result.groups.map((group) => group.kind)).toEqual(["issue", "action"]);
    expect(result.empty).toEqual(["station", "floor", "file"]);
  });

  it("finds a file by its whole name, or without the extension", () => {
    expect(ids("JRTokyoSta_1_Opening.shp")[0]).toEqual(["file", ["file:opening"]]);
    expect(ids("jrtokyosta_1_opening")[0]).toEqual(["file", ["file:opening"]]);
    expect(ids("opening")[0]).toEqual(["file", ["file:opening"]]);
  });

  it("finds Deliver by export", () => {
    expect(ids("export")).toEqual([["action", ["action:deliver"]]]);
  });

  it("matches nothing for an empty query", () => {
    expect(search(ITEMS, "   ")).toEqual({ groups: [], count: 0, empty: [] });
  });
});
