import type { Bilingual, ShapefileStageId } from "../../components/shell/stages";

export type SearchKind = "station" | "floor" | "issue" | "file" | "action";

/** What a result does. Disabled is a state of its own, never a run that silently does nothing. */
export type Run =
  | { kind: "navigate"; to: string }
  | { kind: "page"; invoke: () => void }
  | { kind: "command"; text: string }
  | { kind: "disabled"; reason: Bilingual };

export type SearchItem = {
  id: string;
  kind: SearchKind;
  tone?: "help";
  label: Bilingual;
  detail: Bilingual;
  hint?: Bilingual;
  /** Things to fix, e.g. "3 to fix"; always the danger tone. */
  badge?: Bilingual;
  run: Run;
  /** Normalised match strings. */
  terms: readonly string[];
};

/** A floor of the loaded project: every level sharing one short_name. */
export type FloorRef = { label: string; ordinal: number; levelIds: readonly string[]; shortName: unknown };

export type LevelRef = { id: string; name: string; names: readonly string[]; floor: FloorRef; ordinal: number; outdoor: boolean };

export type StationRef = { projectId: string; name: string };

export type Lexicon = {
  levels: readonly LevelRef[];
  floors: readonly FloorRef[];
  stations: readonly StationRef[];
};

export type Verb = "go" | "assign" | "fix";

export type Place =
  | { kind: "station"; station: StationRef; floor: string | null }
  | { kind: "floor"; floor: FloorRef }
  | { kind: "level"; level: LevelRef }
  | { kind: "stage"; stage: ShapefileStageId };

export type Outdoor = "set" | "clear" | "keep";

export type Command =
  | { verb: "go"; place: Place }
  | { verb: "assign"; alias: "assign" | "move"; level: LevelRef; to: FloorRef; outdoor: Outdoor }
  | { verb: "fix"; scope: "overlaps" };

export type Slot = "place" | "level" | "floor" | "flag" | "scope";

/** `input` is a whole command line; parsing it resolves the completed slot to exactly one candidate. */
export type Completion = { input: string; label: Bilingual; detail: Bilingual };

export type Parse =
  | { mode: "search"; text: string }
  | { mode: "command"; command: Command }
  | { mode: "incomplete"; verb: Verb; expecting: Slot; completions: readonly Completion[] }
  | { mode: "ambiguous"; verb: Verb; slot: Slot; text: string; completions: readonly Completion[] }
  | { mode: "unknown"; verb: Verb; slot: Slot; text: string; completions: readonly Completion[] };

export type GoTarget = { kind: "route"; to: string } | { kind: "floor"; label: string } | { kind: "level"; id: string };

export type ChangeRow = { field: Bilingual; before: string; after: string };

export type Preview =
  | { kind: "go"; sentence: Bilingual; target: GoTarget }
  | { kind: "nothing-to-do"; sentence: Bilingual }
  | { kind: "unavailable"; sentence: Bilingual; reason: Bilingual }
  | {
      kind: "change";
      sentence: Bilingual;
      consequence: Bilingual;
      rows: readonly ChangeRow[];
      followUp: Bilingual;
      highlight: readonly string[];
      certainty: "exact" | "at-most";
      basis: number;
    };
