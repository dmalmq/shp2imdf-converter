import { describe, expect, it } from "vitest";

import { floorAliases, norm } from "./normalize";
import { parse } from "./parse";
import type { FloorRef, LevelRef, Lexicon, Parse } from "./types";

const floor = (label: string, ordinal: number, levelIds: string[]): FloorRef => ({
  label,
  ordinal,
  levelIds,
  shortName: { ja: label }
});

const F0 = floor("0F", 0, ["l-outside"]);
const F1 = floor("1F", 1, ["l-1f", "l-15", "l-roof-1"]);
const F2 = floor("2F", 2, ["l-roof-2", "l-outdoor"]);
const B1 = floor("B1F", -1, ["l-b1"]);
const B10 = floor("B10F", -10, ["l-b10"]);

const level = (id: string, name: string, on: FloorRef, outdoor = false): LevelRef => ({
  id,
  name,
  names: [name],
  floor: on,
  ordinal: on.ordinal,
  outdoor
});

const OUTSIDE = level("l-outside", "屋外", F0);
const TOKYO: Lexicon = {
  levels: [OUTSIDE, level("l-1f", "1F", F1), level("l-15", "1F 15-16番線", F1), level("l-b1", "B1", B1)],
  floors: [F0, F1, F2, B1, B10],
  stations: [{ projectId: "p-tokyo", name: "東京駅" }]
};

const ROOF_1 = level("l-roof-1", "屋外", F1, true);
const ROOF_2 = level("l-roof-2", "屋外", F2, true);
const TWINS: Lexicon = {
  levels: [ROOF_1, ROOF_2, level("l-outdoor", "outdoor", F2)],
  floors: [F1, F2],
  stations: []
};

const SAME_FLOOR: Lexicon = {
  levels: [level("a", "屋外", F1), level("b", "屋外", F1)],
  floors: [F1],
  stations: []
};

function command(result: Parse) {
  if (result.mode !== "command") throw new Error(`expected a command, got ${result.mode}`);
  return result.command;
}

describe("parse", () => {
  it.each([
    ["東京駅 1F"],
    ["overlap"],
    ["JRTokyoSta_1_Opening.shp"],
    ["fix_overlaps.shp"],
    ["export"],
    ["fixes"]
  ])("keeps %s a search", (input) => {
    expect(parse(input, TOKYO)).toEqual({ mode: "search", text: input });
  });

  it.each([
    ["assign 屋外 to 1F outdoor", "assign"],
    ["move 屋外 to 1F outdoor", "move"],
    ["ASSIGN 屋外 TO 1F OUTDOOR", "assign"],
    ["assign 屋外to1F outdoor", "assign"],
    ["assign 屋外to1階 outdoor", "assign"],
    ["assign　屋外　to　１Ｆ　outdoor", "assign"]
  ])("reads %s as moving 屋外 onto 1F, outdoor", (input, alias) => {
    expect(command(parse(input, TOKYO))).toEqual({ verb: "assign", alias, level: OUTSIDE, to: F1, outdoor: "set" });
  });

  it("keeps or clears the outdoor flag", () => {
    expect(command(parse("assign 屋外 to 1F", TOKYO))).toMatchObject({ outdoor: "keep" });
    expect(command(parse("assign 屋外 to 1F indoor", TOKYO))).toMatchObject({ outdoor: "clear" });
  });

  it.each([
    ["１Ｆ", F1],
    ["1階", F1],
    ["B1", B1],
    ["地下1階", B1],
    ["b1f", B1],
    ["B10F", B10]
  ])("finds floor %s by any spelling", (spelling, expected) => {
    expect(command(parse(`assign 屋外 to ${spelling}`, TOKYO))).toMatchObject({ to: expected });
  });

  it("does not let B1 eat the start of B10F, nor guess what ＢＦ is", () => {
    expect(command(parse("go B10F", TOKYO))).toEqual({ verb: "go", place: { kind: "floor", floor: B10 } });
    expect(parse("assign 屋外 to ＢＦ", TOKYO)).toMatchObject({ mode: "unknown", slot: "floor", text: "bf" });
  });

  it("takes a level name with a space in it as one slot", () => {
    expect(command(parse("assign 1F 15-16番線 to 2F", TOKYO))).toMatchObject({ level: { id: "l-15" }, to: F2 });
  });

  it("asks which 屋外 when two floors have one, and each answer names one", () => {
    const result = parse("assign 屋外 to 1F", TWINS);
    expect(result).toMatchObject({ mode: "ambiguous", slot: "level", text: "屋外" });
    if (result.mode !== "ambiguous") return;
    expect(result.completions.map((item) => item.input)).toEqual(["assign 屋外@1F to 1F", "assign 屋外@2F to 1F"]);
    expect(result.completions.map((item) => command(parse(item.input, TWINS)))).toEqual([
      { verb: "assign", alias: "assign", level: ROOF_1, to: F1, outdoor: "keep" },
      { verb: "assign", alias: "assign", level: ROOF_2, to: F1, outdoor: "keep" }
    ]);
    expect(command(parse("assign 屋外@2階 to 1F", TWINS))).toMatchObject({ level: ROOF_2 });
  });

  it("numbers two levels with one name on one floor", () => {
    const result = parse("assign 屋外 to 1F", SAME_FLOOR);
    expect(result.mode).toBe("ambiguous");
    if (result.mode !== "ambiguous") return;
    expect(result.completions.map((item) => item.input)).toEqual(["assign 屋外@1F#1 to 1F", "assign 屋外@1F#2 to 1F"]);
    expect(result.completions.map((item) => command(parse(item.input, SAME_FLOOR)))).toMatchObject([
      { level: { id: "a" } },
      { level: { id: "b" } }
    ]);
  });

  it("reads a level named outdoor as the level, and the flag only after the floor", () => {
    expect(command(parse("assign outdoor to 1F outdoor", TWINS))).toMatchObject({
      level: { id: "l-outdoor" },
      to: F1,
      outdoor: "set"
    });
  });

  it("offers only prefix and substring matches for a typo", () => {
    expect(parse("assign 屋街 to 1F", TOKYO)).toEqual({
      mode: "unknown",
      verb: "assign",
      slot: "level",
      text: "屋街",
      completions: []
    });
    expect(parse("go 2f platform", TOKYO)).toMatchObject({ mode: "unknown", slot: "place" });
  });

  it("completes what is missing", () => {
    expect(parse("assign 屋", TOKYO)).toMatchObject({
      mode: "incomplete",
      expecting: "level",
      completions: [{ input: "assign 屋外 to " }]
    });
    const floors = parse("assign 屋外 to", TOKYO);
    expect(floors).toMatchObject({ mode: "incomplete", expecting: "floor" });
    if (floors.mode === "incomplete") {
      for (const item of floors.completions) expect(parse(item.input, TOKYO).mode).toBe("command");
    }
    expect(parse("assign 屋外 to 1F out", TOKYO)).toMatchObject({
      mode: "incomplete",
      expecting: "flag",
      completions: [{ input: "assign 屋外 to 1F outdoor" }]
    });
  });

  it("reads fix overlap and fix overlaps", () => {
    expect(command(parse("fix overlaps", TOKYO))).toEqual({ verb: "fix", scope: "overlaps" });
    expect(command(parse("fix overlap", TOKYO))).toEqual({ verb: "fix", scope: "overlaps" });
    expect(parse("fix ov", TOKYO)).toMatchObject({ mode: "incomplete", completions: [{ input: "fix overlaps" }] });
    expect(parse("fix all", TOKYO)).toMatchObject({ mode: "unknown", slot: "scope" });
  });

  it("goes to a station, a floor on it, a floor, a level or a stage", () => {
    expect(command(parse("go 東京駅 1F", TOKYO))).toEqual({
      verb: "go",
      place: { kind: "station", station: TOKYO.stations[0], floor: "1F" }
    });
    expect(command(parse("go 東京駅1階", TOKYO))).toMatchObject({ place: { kind: "station", floor: "1F" } });
    expect(command(parse("go 1F", TOKYO))).toEqual({ verb: "go", place: { kind: "floor", floor: F1 } });
    expect(command(parse("go 屋外", TOKYO))).toEqual({ verb: "go", place: { kind: "level", level: OUTSIDE } });
    expect(command(parse("go check", TOKYO))).toEqual({ verb: "go", place: { kind: "stage", stage: "check" } });
    expect(command(parse("go set up", TOKYO))).toEqual({ verb: "go", place: { kind: "stage", stage: "set-up" } });
  });
});

describe("floorAliases", () => {
  it.each([
    ["１Ｆ", ["1f", "1階"]],
    ["1.5F", ["1.5f", "1.5階"]],
    ["B1", ["b1", "b1f", "地下1階", "地下1f"]],
    ["M2F", ["m2f", "m2", "中2階"]],
    ["中2階", ["中2階", "m2f", "m2"]],
    ["RF", ["rf", "r", "屋上"]],
    ["R", ["r", "rf", "屋上"]],
    ["ＢＦ", ["bf"]],
    ["ラチ内", ["ラチ内"]],
    ["PH", ["ph"]]
  ])("%s is found by %j", (label, expected) => {
    expect(new Set(floorAliases(label))).toEqual(new Set(expected));
  });

  it("never adds a bare number", () => {
    expect(floorAliases("1F")).not.toContain("1");
    expect(norm("１Ｆ")).toBe("1f");
  });
});
