import type { ShapefileStageId } from "../../components/shell/stages";
import { endsAtBoundary, floorAliases, norm } from "./normalize";
import type { Completion, FloorRef, LevelRef, Lexicon, Parse, Place, StationRef } from "./types";

const VERBS: ReadonlyMap<string, { verb: "go" | "assign" | "fix"; alias: "assign" | "move" }> = new Map([
  ["go", { verb: "go", alias: "assign" }],
  ["assign", { verb: "assign", alias: "assign" }],
  ["move", { verb: "assign", alias: "move" }],
  ["fix", { verb: "fix", alias: "assign" }]
]);

const STAGES: ReadonlyArray<[string, ShapefileStageId]> = [
  ["bring-in", "bring-in"],
  ["bring in", "bring-in"],
  ["set-up", "set-up"],
  ["set up", "set-up"],
  ["check", "check"],
  ["deliver", "deliver"]
];

const MAX_COMPLETIONS = 8;

type Value =
  | { kind: "level"; level: LevelRef }
  | { kind: "floor"; floor: FloorRef }
  | { kind: "station"; station: StationRef }
  | { kind: "stage"; stage: ShapefileStageId };

type Entry = { key: string; value: Value; ref: object };

type Index = { levels: Entry[]; floors: Entry[]; places: Entry[]; unique: Map<LevelRef, string> };

const indexes = new WeakMap<Lexicon, Index>();

/** The shortest spelling that names one level: its name, name@floor, or name@floor#n. */
function uniqueForms(levels: readonly LevelRef[]): Map<LevelRef, string> {
  const forms = new Map<LevelRef, string>();
  for (const level of levels) {
    const name = norm(level.name);
    const sameName = levels.filter((other) => other.names.some((item) => norm(item) === name));
    if (sameName.length === 1) {
      forms.set(level, level.name);
      continue;
    }
    const sameFloor = sameName.filter((other) => other.floor.label === level.floor.label);
    if (sameFloor.length === 1) {
      forms.set(level, `${level.name}@${level.floor.label}`);
      continue;
    }
    const position = [...sameFloor].sort((a, b) => a.id.localeCompare(b.id)).indexOf(level) + 1;
    forms.set(level, `${level.name}@${level.floor.label}#${position}`);
  }
  return forms;
}

function buildIndex(lexicon: Lexicon): Index {
  const levels: Entry[] = [];
  for (const level of lexicon.levels) {
    const names = [...new Set(level.names.map(norm).filter(Boolean))];
    const sameFloorSameName = (name: string) =>
      lexicon.levels
        .filter((other) => other.floor.label === level.floor.label && other.names.some((item) => norm(item) === name))
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const name of names) {
      levels.push({ key: name, value: { kind: "level", level }, ref: level });
      const siblings = sameFloorSameName(name);
      for (const alias of floorAliases(level.floor.label)) {
        levels.push({ key: `${name}@${alias}`, value: { kind: "level", level }, ref: level });
        levels.push({ key: `${name}@${alias}#${siblings.indexOf(level) + 1}`, value: { kind: "level", level }, ref: level });
      }
    }
  }
  const floors: Entry[] = lexicon.floors.flatMap((floor) =>
    floorAliases(floor.label).map((key) => ({ key, value: { kind: "floor" as const, floor }, ref: floor }))
  );
  const stations: Entry[] = lexicon.stations
    .filter((station) => norm(station.name))
    .map((station) => ({ key: norm(station.name), value: { kind: "station" as const, station }, ref: station }));
  const stages: Entry[] = STAGES.map(([key, stage]) => ({ key, value: { kind: "stage" as const, stage }, ref: { stage } }));
  const stageRefs = new Map<ShapefileStageId, object>();
  for (const entry of stages) {
    const stage = (entry.value as { stage: ShapefileStageId }).stage;
    entry.ref = stageRefs.get(stage) ?? entry.ref;
    stageRefs.set(stage, entry.ref);
  }
  return { levels, floors, places: [...stages, ...stations, ...floors, ...levels], unique: uniqueForms(lexicon.levels) };
}

function indexFor(lexicon: Lexicon): Index {
  let index = indexes.get(lexicon);
  if (!index) {
    index = buildIndex(lexicon);
    indexes.set(lexicon, index);
  }
  return index;
}

/** The longest entries that start `text` and end at a boundary; several when they tie. */
function longest(text: string, entries: readonly Entry[]): { length: number; matches: Entry[] } | null {
  let length = 0;
  let matches: Entry[] = [];
  for (const entry of entries) {
    if (entry.key.length < length || !text.startsWith(entry.key) || !endsAtBoundary(text, entry.key, entry.key.length)) {
      continue;
    }
    if (entry.key.length > length) {
      length = entry.key.length;
      matches = [];
    }
    if (!matches.some((item) => item.ref === entry.ref)) matches.push(entry);
  }
  return length > 0 ? { length, matches } : null;
}

/** Entries starting with `fragment`, then those containing it; one per thing named. */
function suggestions(fragment: string, entries: readonly Entry[]): { prefix: Entry[]; all: Entry[] } {
  const seen = new Set<object>();
  const pick = (test: (key: string) => boolean) =>
    entries.filter((entry) => {
      if (seen.has(entry.ref) || !test(entry.key)) return false;
      seen.add(entry.ref);
      return true;
    });
  const prefix = fragment ? pick((key) => key.startsWith(fragment)) : pick(() => true);
  const contains = fragment ? pick((key) => key.includes(fragment)) : [];
  return { prefix, all: [...prefix, ...contains].slice(0, MAX_COMPLETIONS) };
}

function levelLabel(level: LevelRef) {
  return {
    label: { en: `${level.name} on ${level.floor.label}`, ja: `${level.floor.label} の ${level.name}` },
    detail: { en: "Level", ja: "レベル" }
  };
}

function floorLabel(floor: FloorRef) {
  return { label: { en: floor.label, ja: floor.label }, detail: { en: "Floor", ja: "フロア" } };
}

function describe(value: Value, index: Index): { spelling: string; label: Completion["label"]; detail: Completion["detail"] } {
  switch (value.kind) {
    case "level":
      return { spelling: index.unique.get(value.level) ?? value.level.name, ...levelLabel(value.level) };
    case "floor":
      return { spelling: value.floor.label, ...floorLabel(value.floor) };
    case "station":
      return {
        spelling: value.station.name,
        label: { en: value.station.name, ja: value.station.name },
        detail: { en: "Station", ja: "駅" }
      };
    case "stage":
      return {
        spelling: value.stage,
        label: { en: value.stage, ja: value.stage },
        detail: { en: "Stage", ja: "ステージ" }
      };
  }
}

function completion(value: Value, index: Index, before: string, after: string): Completion {
  const { spelling, label, detail } = describe(value, index);
  return { input: `${before}${spelling}${after}`, label, detail };
}

/** `to`, when it is a word of its own: `屋外to1f` has one, `tokyo` does not. */
function stripConnective(text: string): string {
  const trimmed = text.trimStart();
  return /^to(?![a-z])/.test(trimmed) ? trimmed.slice(2).trimStart() : trimmed;
}

function connectiveAt(text: string): number {
  const match = /(^|\s|[^a-z])to(?![a-z])/.exec(text);
  return match ? match.index + match[1].length : -1;
}

/** `1階`, `1f` → `1F`; `地下1階` → `B1F`; other text as typed. */
export function canonicalFloor(text: string): string {
  const key = norm(text);
  let match: RegExpExecArray | null;
  if ((match = /^(\d+(?:\.\d+)?)(?:f|階)$/.exec(key))) return `${match[1]}F`;
  if ((match = /^(?:b|地下)(\d+)(?:f|階)?$/.exec(key))) return `B${match[1]}F`;
  if ((match = /^(?:m|中)(\d+)(?:f|階)?$/.exec(key))) return `M${match[1]}F`;
  if (key === "rf" || key === "r" || key === "屋上") return "RF";
  return text.trim();
}

/** What follows a level, written back with the floor's own label: ` to 1F outdoor`. */
function renderTail(after: string, index: Index): string {
  const tail = stripConnective(after);
  const floorFound = tail ? longest(tail, index.floors) : null;
  if (!floorFound || floorFound.matches.length !== 1) return tail ? ` to ${tail}` : " to ";
  const label = (floorFound.matches[0].value as { floor: FloorRef }).floor.label;
  const flag = tail.slice(floorFound.length).trim();
  return ` to ${label}${flag ? ` ${flag}` : ""}`;
}

export function parse(input: string, lexicon: Lexicon): Parse {
  const text = norm(input);
  const space = text.indexOf(" ");
  const head = space < 0 ? text : text.slice(0, space);
  const verb = VERBS.get(head);
  if (!verb) return { mode: "search", text: input.trim() };
  const rest = space < 0 ? "" : text.slice(space + 1);
  const index = indexFor(lexicon);
  if (verb.verb === "fix") return parseFix(rest);
  if (verb.verb === "go") return parseGo(rest, index);
  return parseAssign(rest, index, verb.alias);
}

function parseFix(rest: string): Parse {
  if (rest === "overlaps" || rest === "overlap") return { mode: "command", command: { verb: "fix", scope: "overlaps" } };
  const only: Completion = {
    input: "fix overlaps",
    label: { en: "fix overlaps", ja: "fix overlaps" },
    detail: { en: "Trim the overlaps that have a clear answer", ja: "はっきりした重なりを解消" }
  };
  if ("overlaps".startsWith(rest)) return { mode: "incomplete", verb: "fix", expecting: "scope", completions: [only] };
  return { mode: "unknown", verb: "fix", slot: "scope", text: rest, completions: "overlaps".includes(rest) ? [only] : [] };
}

function placeOf(value: Value, after: string): Place {
  switch (value.kind) {
    case "station":
      return { kind: "station", station: value.station, floor: after ? canonicalFloor(after) : null };
    case "floor":
      return { kind: "floor", floor: value.floor };
    case "level":
      return { kind: "level", level: value.level };
    case "stage":
      return { kind: "stage", stage: value.stage };
  }
}

const PLACE_ORDER: ReadonlyArray<Value["kind"]> = ["floor", "stage", "station", "level"];

function parseGo(rest: string, index: Index): Parse {
  if (!rest) {
    const completions = suggestions("", [...index.places.filter((entry) => entry.value.kind !== "level")])
      .all.map((entry) => completion(entry.value, index, "go ", ""));
    return { mode: "incomplete", verb: "go", expecting: "place", completions };
  }
  const found = longest(rest, index.places);
  if (!found) {
    const { prefix, all } = suggestions(rest, index.places);
    const completions = all.map((entry) => completion(entry.value, index, "go ", ""));
    return prefix.length > 0
      ? { mode: "incomplete", verb: "go", expecting: "place", completions }
      : { mode: "unknown", verb: "go", slot: "place", text: rest, completions };
  }
  const kind = PLACE_ORDER.find((candidate) => found.matches.some((entry) => entry.value.kind === candidate))!;
  const matches = found.matches.filter((entry) => entry.value.kind === kind);
  const after = rest.slice(found.length).trim();
  if (matches.length > 1) {
    return {
      mode: "ambiguous",
      verb: "go",
      slot: "place",
      text: rest.slice(0, found.length),
      completions: matches.map((entry) => completion(entry.value, index, "go ", after ? ` ${after}` : ""))
    };
  }
  const value = matches[0].value;
  if (after && value.kind !== "station") {
    return { mode: "unknown", verb: "go", slot: "place", text: rest, completions: [completion(value, index, "go ", "")] };
  }
  return { mode: "command", command: { verb: "go", place: placeOf(value, after) } };
}

function parseAssign(rest: string, index: Index, alias: "assign" | "move"): Parse {
  const verbText = `${alias} `;
  if (!rest) {
    const completions = suggestions("", index.levels).all.map((entry) => completion(entry.value, index, verbText, " to "));
    return { mode: "incomplete", verb: "assign", expecting: "level", completions };
  }

  const found = longest(rest, index.levels);
  if (!found) {
    const cut = connectiveAt(rest);
    const fragment = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    const tail = cut >= 0 ? ` ${rest.slice(cut)}` : " to ";
    const { prefix, all } = suggestions(fragment, index.levels);
    const completions = all.map((entry) => completion(entry.value, index, verbText, tail));
    return cut < 0 && prefix.length > 0
      ? { mode: "incomplete", verb: "assign", expecting: "level", completions }
      : { mode: "unknown", verb: "assign", slot: "level", text: fragment, completions };
  }

  const after = rest.slice(found.length);
  if (found.matches.length > 1) {
    const tail = renderTail(after, index);
    return {
      mode: "ambiguous",
      verb: "assign",
      slot: "level",
      text: rest.slice(0, found.length),
      completions: found.matches.map((entry) => completion(entry.value, index, verbText, tail))
    };
  }
  const level = (found.matches[0].value as { level: LevelRef }).level;
  const levelText = `${verbText}${index.unique.get(level) ?? level.name} to `;

  const tail = stripConnective(after);
  if (!tail) {
    const completions = suggestions("", index.floors).all.map((entry) => completion(entry.value, index, levelText, ""));
    return { mode: "incomplete", verb: "assign", expecting: "floor", completions };
  }
  const floorFound = longest(tail, index.floors);
  if (!floorFound) {
    const fragment = tail.split(" ")[0];
    const { prefix, all } = suggestions(fragment, index.floors);
    const completions = all.map((entry) => completion(entry.value, index, levelText, ""));
    return fragment === tail && prefix.length > 0
      ? { mode: "incomplete", verb: "assign", expecting: "floor", completions }
      : { mode: "unknown", verb: "assign", slot: "floor", text: fragment, completions };
  }
  if (floorFound.matches.length > 1) {
    return {
      mode: "ambiguous",
      verb: "assign",
      slot: "floor",
      text: tail.slice(0, floorFound.length),
      completions: floorFound.matches.map((entry) => completion(entry.value, index, levelText, tail.slice(floorFound.length)))
    };
  }
  const to = (floorFound.matches[0].value as { floor: FloorRef }).floor;

  const flag = tail.slice(floorFound.length).trim();
  const outdoor = flag === "" ? "keep" : flag === "outdoor" ? "set" : flag === "indoor" ? "clear" : null;
  if (outdoor === null) {
    const floorText = `${levelText}${to.label} `;
    const completions: Completion[] = (["outdoor", "indoor"] as const)
      .filter((word) => word.startsWith(flag))
      .map((word) => ({
        input: `${floorText}${word}`,
        label: { en: word, ja: word },
        detail: word === "outdoor" ? { en: "Mark it as outdoor", ja: "屋外にする" } : { en: "Mark it as indoor", ja: "屋内にする" }
      }));
    return completions.length > 0
      ? { mode: "incomplete", verb: "assign", expecting: "flag", completions }
      : { mode: "unknown", verb: "assign", slot: "flag", text: flag, completions };
  }
  return { mode: "command", command: { verb: "assign", alias, level, to, outdoor } };
}
