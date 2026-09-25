# Design: search and commands (phase 12)

Back to [overview](overview.md) · [phase 12](phase-12-search.md). Status: revised
2026-09-25 after an independent critique (verdict: approve with changes; every required
change is folded in below, and the coordinator's rulings on the optional items are recorded in
§10).

Figma (page 110:2): Start, search open, 115:186 (panel 115:372); Check with "overlap" typed,
117:2 (panel 117:273); Check with a typed command, 117:341 (panel 117:614); Start in 日本語
with "東京駅 1F" typed, 119:2 (panel 119:193); concept notes, 120:2. There are dark twins at
121:180 and 121:458.

## What the frames ask for

- **Empty field (115:372).** It shows Next fix (the issue, "Open on the map", Enter), Recent
  stations (the stage line and Continue / Open), and Things you can do (Bring in more files,
  Deliver with "3 to fix", Switch to 日本語, Start from Illustrator artwork, Help). The footer
  says "Try 東京駅 1F · overlap · JRTokyoSta_1_Opening.shp · export", then "↑ ↓ to move · Enter
  to open · keys optional".
- **Search "overlap" on Check (117:273).** A scope line reads "Looking in 東京駅 | All
  stations · 4 matches". The Issues group ("1 must fix") comes first, then Floors, then Actions
  (Resolve the overlap, Run the overlap check again, and a HELP row "Why overlaps block
  delivery"). The footer names the groups that are empty: "Nothing in Stations or Files matches
  'overlap'".
- **Typed command (117:614).** A `COMMAND` chip sits in the field. The panel shows
  "Understood as" chips (`move` · `level 屋外 (now on 0F)` → `floor 1F` + `mark as outdoor`),
  then a sentence, a paragraph on what moves with it, and a before → after table (Floor,
  Ordinal, Outdoor). A follow-up line says the changed floors are checked again. Below that are
  Apply (Enter), Cancel (Esc) and "Then you'll see: Moved 屋外 to 1F. Undo". An "Or did you
  mean" section offers a go-to item and a floor item, and the footer reads "Typed commands and
  buttons do the same thing, and both can be undone · Tab completes". The map outlines where
  the features will land, and it is not dimmed.
- **日本語, "東京駅 1F" on the hub (119:193).** Groups are ordered by how well they match:
  フロア (東京駅 · 1F, 地図で開く), then 駅, 課題, ファイル and 操作. The footer says
  "コマンドも使えます：assign 屋外 to 1F outdoor", so **the command words stay English in both
  languages** and only the names are Japanese.

## 1. Types

All of these are frontend types in `frontend/src/lib/search/`. Each type is built so that a
half-resolved or contradictory value cannot be written.

```ts
type Bilingual = { en: string; ja: string };

type SearchKind = "station" | "floor" | "issue" | "file" | "action";

/** What a result does. Disabled is a state of its own, never a run() that silently does nothing. */
type Run =
  | { kind: "navigate"; to: string }              // a route; ?floor= / ?issue= ride along as hints
  | { kind: "page"; invoke: () => void }          // a handler the page or shell registered
  | { kind: "command"; text: string }             // puts a command in the field; never applies it
  | { kind: "disabled"; reason: Bilingual };

type SearchItem = {
  id: string;                  // stable per source, e.g. "floor:1F", "issue:must:overlapping_units:0"
  kind: SearchKind;
  tone?: "help";               // the frame's HELP chip, still in the Actions group
  label: Bilingual;
  detail: Bilingual;
  hint?: Bilingual;            // "Continue", "Open on the map", "Go to 1F"
  badge?: Bilingual;           // "3 to fix"; always the danger tone
  run: Run;
  /** Pre-normalised match strings (names in every language, stems, check ids). */
  terms: readonly string[];
};
```

The phase plan's `{ kind, label, detail, run }` is kept. `run` is a tagged value rather than a
thunk, so the panel can tell navigate from command from disabled without calling anything, and
tests can assert on it.

The typed command language:

```ts
type Verb = "go" | "assign" | "fix";              // "move" is an alias of assign, not a verb

type FloorRef = { label: string; ordinal: number; levelIds: readonly string[]; shortName: unknown };
type LevelRef = { id: string; name: string; floor: FloorRef; outdoor: boolean; ordinal: number };

type Place =
  | { kind: "station"; projectId: string; name: string; floor: string | null } // floor unresolved: that project is not loaded
  | { kind: "floor"; floor: FloorRef }
  | { kind: "level"; level: LevelRef }
  | { kind: "stage"; stage: ShapefileStageId };

type Command =
  | { verb: "go"; place: Place }
  | { verb: "assign"; level: LevelRef; to: FloorRef; outdoor: "set" | "clear" | "keep" }
  | { verb: "fix"; scope: "overlaps" };
```

A `Command` only exists once every slot has been resolved against the loaded data. Everything
short of that is a `Parse`:

```ts
type Slot = "place" | "level" | "floor" | "scope";

type Parse =
  | { mode: "search"; text: string }                              // the raw first token is not a verb
  | { mode: "command"; command: Command }
  | { mode: "incomplete"; verb: Verb; expecting: Slot; completions: readonly Completion[] }
  | { mode: "ambiguous"; verb: Verb; slot: Slot; text: string; completions: readonly Completion[] }
  | { mode: "unknown"; verb: Verb; slot: Slot; text: string; completions: readonly Completion[] };

/** `input` is the whole command line the completion produces; parsing it yields exactly one candidate. */
type Completion = { input: string; label: Bilingual; detail: Bilingual };
```

A preview is pure data, derived from a `Command` and a snapshot:

```ts
type Preview =
  | { kind: "navigate"; sentence: Bilingual; to: string }
  | { kind: "page"; sentence: Bilingual; invoke: () => void }         // go to a floor or level on Check
  | { kind: "nothing-to-do"; sentence: Bilingual }                    // 屋外 is already on 1F and outdoor
  | { kind: "unavailable"; sentence: Bilingual; reason: Bilingual }
  | {
      kind: "change";
      sentence: Bilingual;               // "Move the 屋外 level onto floor 1F and mark it as outdoor."
      consequence: Bilingual;            // "Its 2 units and 1 opening move with it. Nothing is saved until you apply."
      rows: readonly { field: Bilingual; before: string; after: string }[];
      followUp: Bilingual;               // "Afterwards the whole project is checked again."
      highlight: readonly string[];      // feature ids the map outlines
      certainty: "exact" | "at-most";    // a fix preview counts candidates, not outcomes
      basis: number;                     // the content_rev the snapshot was read at
    };
```

`unavailable` always carries a reason, and `change` always carries its before and after values
and the revision it was read at. There is no preview that can be applied but has nothing to
show. The "Then you'll see" line is not part of the preview. After Apply, the toast and the
Done row are worded from the server's reply (§5).

## 2. Grammar and tokenisation

```
input    := command | search
command  := verb (SP args)?                        verb = the raw first whitespace token
verb     := "go" | "assign" | "move" | "fix"        (English in both UI languages, as 119:193 shows)
go       := place
place    := station [floor-text] | floor | level | stage
assign   := level SP? "to" SP? floor (SP flag)?
flag     := "outdoor" | "indoor"
fix      := "overlaps" | "overlap"
stage    := "bring-in" | "bring in" | "set-up" | "set up" | "check" | "deliver"
```

**Normalisation.** `norm()` runs NFKC first, so full-width becomes half-width: `１Ｆ` → `1F`,
`ＢＦ` → `BF`, `ｅｘｐｏｒｔ` → `export`, and U+3000 becomes a space. Then it lower-cases and
collapses whitespace. The same function normalises the input and every lexicon entry and term.

**The verb comes from the raw first whitespace token**, taken after `norm()` but before any
`_ - ・ ·` word-splitting, and it must equal a verb exactly. `fix_overlaps.shp` and
`go-live.dbf` therefore stay file searches, and `fixes` is a search too.

**Slots come from a lexicon, not from whitespace.** After the verb, the parser takes the
longest lexicon entry of the slot's kind that is a prefix of the remaining text. Then it expects
the connective or the next slot. An entry that ends in an ASCII letter or digit only matches
when the next character is not also an ASCII letter or digit, so `B1` does not eat the start of
`B10F`. The connective `to` is recognised when the next character is not an ASCII letter.

- `assign 屋外 to 1F outdoor` resolves to level 屋外, `to`, floor 1F, flag outdoor.
- `assign 屋外to1階` works too. Japanese is typed without spaces, the level entry `屋外` is a
  prefix, `to` is followed by a digit, and `1階` is an alias entry of floor 1F.
- A name with spaces in it, such as 新宿's `1F 15-16番線`, is one slot, because the longest
  entry wins over the space.
- A level named `outdoor` is still a level in the level slot, and the flag is only read after
  the floor: `assign outdoor to 1F outdoor` is level `outdoor`, floor 1F, flag set.

**Levels.** Each level feature adds its name, in every language it has, as an entry. It also
adds a **qualified form**, `name@floor`, for each of its floor's aliases (`屋外@2F`,
`屋外@2階`). When two levels share a name on the same floor, the qualified form gets a 1-based
suffix in id order (`屋外@2F#2`). Two levels named `屋外` on 1F and 2F therefore make `assign
屋外 to 1F` `ambiguous`. Its completions are `assign 屋外@1F to 1F` and `assign 屋外@2F to 1F`,
and each completion's `input` re-parses to exactly one command, which the table tests assert
for every completion they produce.

**Floors.** Each floor (a `buildFloorGroups` entry, keyed by `short_name`) adds its label and
the aliases derived from the label. Every alias is its own lexicon entry, so prefix matching
without spaces works for aliases as it does for labels. The label is normalised first, then
matched whole:

| Label (after NFKC) | Aliases added |
|---|---|
| `nF`, `n階` (`n` an integer or a decimal: `1F`, `1.5F`) | `nF`, `n階`; bare `n` is never an alias, since it would match file stems |
| `BnF`, `Bn`, `地下n階`, `地下nF` | all four |
| `MnF`, `Mn`, `中n階` | all three |
| `RF`, `R`, `屋上`, `PH` | `RF`, `R`, `屋上` (`PH` only as itself) |
| `BF`, and anything else (`ラチ内`, `P`) | only itself; it is not guessed |

`ＢＦ` therefore normalises to `BF` and finds only a floor actually labelled `BF`.

**Unknown text.** Text that matches nothing becomes `unknown`. Its completions are the slot's
entries that start with the text, then those that contain it. v1 has **no edit-distance
matching**, so a typo such as `asign`, or `屋街` for `屋外`, gets prefix and substring
suggestions only, which may be none. Hiragana and katakana are **not unified** in v1, so
`おくがい` does not find `屋外`.

**Search mode** is used whenever the first token is not a verb. That covers `東京駅 1F`,
`overlap`, `JRTokyoSta_1_Opening.shp` and `export`. The query is split on whitespace. A term
that mixes scripts and matches nothing whole (`東京駅1F`) is split again at CJK/Latin
boundaries. An item matches when it covers at least one term. The score is the number of terms
covered, then the match quality (exact, then prefix, then word-prefix, then substring). Items of
the loaded project carry its station name as a term, so `東京駅 1F` puts the floor, which
covers both terms, above the station, which covers one. That is 119:193's order. Groups are
ordered by their best item, and ties go Stations, Floors, Issues, Files, Actions. There are at
most 5 items per group. A filename matches with or without its extension, and `_ - ・ ·` are
word breaks for word-prefix matching.

`export` and `deliver` are not verbs. They are keywords on the Deliver action ("export ·
deliver" in 120:2), so they stay in search mode.

### Parser alternatives

| | A. Whitespace tokens + recursive descent | **B. Verb table + lexicon-driven longest match** (chosen) | C. PEG / parser-combinator library |
|---|---|---|---|
| Japanese without spaces (`屋外to1階`) | Fails without heuristic splitting | Works: slots are found by name | Only with the lexicon injected per project |
| Names with spaces (`1F 15-16番線`) | Needs quoting, which nobody types | Works (the longest entry wins) | Same as A unless injected |
| Same name on two floors | Invisible: the first one wins | `ambiguous`, with qualified completions | Reports errors, not candidates |
| Completion (Tab) | Hand-built | Free: the remainder is a prefix query on the slot's entries | Hand-built on error positions |
| Cost | Smallest code | Pure and table-testable | New dependency |

With B, the parse is a pure function `parse(input, lexicon): Parse`, and the table tests call it
with a fixture lexicon.

## 3. Verbs in v1

| Verb | Example | Endpoint | Where it applies |
|---|---|---|---|
| `go` | `go 東京駅 1F`, `go check`, `go 屋外` | none: navigation or a page handler; `?floor=` / `?issue=` hints are read once by Check on arrival | anywhere; stages respect `stageReachable` |
| `assign` (alias `move`) | `assign 屋外 to 1F outdoor` | `PATCH /api/session/{id}/features/bulk`, `action: "patch"`, `with_undo: true`, `base_rev` | Check, with features loaded |
| `fix` | `fix overlaps`, `fix overlap` | `POST …/overlaps/fix-safe?base_rev=` | Check, with current checks |

`assign` does what 117:614 describes. It gives the level the target floor's ordinal and whole
`short_name` label object, and sets `outdoor` when a flag is typed. Units, openings and
amenities point at the level by `level_id`, so they move without being touched, and the preview
counts them. Outside Check, the preview is `unavailable` ("Open Check to move levels"). It does
not fall through to `PATCH /wizard/levels`, because Set up autosaves its own drafts and a second
writer would race them.

These are cut from v1: `fix all` (coordinator's ruling: `fix overlaps` covers the frame),
`select`, `rename`, the keep-A / keep-B overlap choice (the "Resolve the overlap" action opens
the existing issue popover instead), and the prompted autofix.

## 4. Preview without side effects

`preview(command, snapshot): Preview` is a pure function. The snapshot is what Check has
registered (§6): features, validation, floor groups and the `content_rev` from its last
`GET /features`. It makes no request, writes nothing to the store and does not touch the map.

- **assign** reads the level's ordinal, short_name and outdoor values, and the target floor's
  values, from the snapshot. It counts, by type, the features whose `level_id` is the level's
  id. The rows are Floor, Ordinal and Outdoor. `highlight` is the level plus those features.
  If nothing would change, the result is `nothing-to-do`.
- **fix overlaps** counts distinct `overlapping_units` pairs in the current validation. The
  server decides which pairs are clear-cut, so the preview is `at-most` ("Trims up to 4
  overlaps; any that need your choice stay on the list"). Without current checks, the preview is
  `unavailable` ("Run the checks first").
- **go** gives a `navigate` or `page` preview. Enter follows it.

The map outline is view state, not data. The panel passes `highlight` to Check's
`showPreview(ids | null)`, and clears it on Cancel, Esc, close and Apply.

## 5. Apply and Undo

Check already has one path for every fix. `applyFix` applies the revalidation, reloads the
features and records `{label, undo}` in the Done list. `undoFix` sends that `undo` back through
`PATCH …/features/bulk` `action: "restore"`, guarded by the fingerprints and seal (409
`UNDO_STALE`, 400 `UNDO_INVALID`). Commands reuse both.

**The server guards Apply.** `GET /features` gains an additive `content_rev` field. The bulk
PATCH gains an optional `base_rev`, and `overlaps/fix-safe` gains an optional `base_rev` query
parameter. When either is given and differs from the session's `content_rev`, the request is
refused with 409 `REVISION_STALE` before anything is written. Existing callers send neither and
behave as today. On a 409, the page reloads its features, the panel re-derives the preview from
the new snapshot, and it says "This changed since you looked; here it is again". The client's
own `basis` check is kept only as a cheap early exit.

**Undo on a bulk `patch` is opt-in.** With `with_undo: true`, and only then, the `patch` action:

1. builds an undo with the existing `finish_fix(before, after)`;
2. revalidates, as `restore` already does, which is the choice for critique item 7 (the wrapper
   does not call `/validate` separately);
3. returns a separate response model, `{ updated_count, deleted_count, undo, validation,
   content_rev }`.

Without the flag, the response and its cost are unchanged. `applyBulkLevel`, `applyBulkCategory`
and the other table actions never send it.

**What the colleague sees is the server's count.** The toast and the Done row are worded from
the reply, not from the preview. For `assign`, that is `updated_count` ("Moved 屋外 to 1F", or
"Nothing changed" when it is 0). For `fix overlaps`, it is `resolved_pairs` and
`skipped_count` ("Trimmed 3 overlaps · 1 needs your choice"). A reply that changed nothing
records no Done row.

**The toast's Undo.** `ToastProvider` gains an optional `action` and a way to withdraw it. Check
withdraws every command toast's Undo when it unmounts and when the session changes. The Done
list stays the lasting place to undo, and `undoable()` still withdraws Undo there once a later
fix touches the same features.

Rejected alternatives: undo by sending the old properties back (no fingerprint guard, so it
would silently overwrite an edit from another tab, which the 2026-09-25 Undo decision exists to
prevent), and `editHistory` (single-feature and unguarded, and Ctrl Z on Check already means
"undo the last table edit").

## 6. Where search data comes from, and what it costs

| Source | Feeds | How | Cost |
|---|---|---|---|
| `GET /api/projects?flow=shapefiles` | Stations, Recent stations, the hub's Next fix, Deliver's badge | fetched when the panel **opens**; the last copy shows at once | one index-only request per open, which never touches a session |
| Store: `files`, `wizardState.levels`, `sessionId`, `uiLanguage` | Files; Floors outside Check | read directly; the hub keeps the last project in the store | none |
| Check's registration | Floors, Issues, Next fix, the command snapshot, and the page handlers | `useSearchSource()` in a search-only context beside the shell | none |
| Static | Actions, stage names, verbs, `issueCopy` | module constants | none |

Check registers `{ sessionId, contentRev, features, validation, floors, openIssue, showFloor,
showLevel, runChecks, showPreview, apply }`. It already holds all of these in memory.

**Floors outside Check** come from `wizardState.levels`, which is Set up's level mapping (the
distinct `short_name`s and their ordinals). They do not reflect an `assign` made on Check,
because `assign` changes the features, not the wizard. The panel keeps the floors from Check's
last registration for the same session, and uses those in preference to the wizard's until the
session changes. After an `assign`, the Floors group away from Check therefore shows Check's
last floors. This staleness is documented rather than refreshed, since refreshing would mean
reading the session.

**Nothing per keystroke touches the network.** Each source's items are built and normalised
once per source identity. At most 300 issues are indexed, must fix first and then can wait in
the rail's order (`MAX_ISSUE_ITEMS`), so a large session's warnings do not grow the scan. A
keystroke scans a few hundred items at most, and
`useDeferredValue` keeps typing ahead of rendering. Unit and amenity names are not indexed in
this phase, and the placeholder no longer promises "features" (§10).

**Other projects' floors, issues and files are never fetched.** Every per-session GET goes
through `get_session_or_raise`, which touches `last_accessed`. Looking into 新宿 from the search
panel would count as opening it: it would reorder the hub and extend 新宿's 30-day life. So:

- On the hub, **Next fix** for a project that is not loaded shows the summary's count ("東京駅 ·
  3 things before you can deliver") and opens its Check. The issue sentence appears only when
  Check has registered that project.
- On the hub, `東京駅 1F` for a project that is not loaded gives "東京駅 · 1F", which opens
  `/p/:id/check?floor=1F`. Check applies the hint when that floor exists.
- **Opening another project always goes through the route** (`navigate`), so ProjectRoutes'
  `switchProject` runs as it does for a hub card. Search never calls `switchProject`.
- "All stations" in the scope line narrows the panel to the Stations group and fetches nothing.

## 7. Keyboard and accessibility

- **Open.** Ctrl K (⌘K on macOS) from anywhere, including inside Set up's inputs, is handled on
  `window` in the capture phase with `preventDefault`, so the browser's own Ctrl K never fires.
  Clicking the field also opens it. The field replaces the empty `data-slot="search"` in the
  top bar, with the `Ctrl K` kbd hint.
- **Pattern.** ARIA 1.2 combobox with a listbox popup. The input has `role="combobox"`,
  `aria-expanded`, `aria-controls` and `aria-activedescendant`, and focus never leaves it while
  the user moves through results. Each group is `role="group"` with `aria-labelledby` pointing
  at its heading. Each row is `role="option"` with `aria-selected`, and the kind chip is part of
  the option's name.
- **Keys.** ↑ and ↓ move and wrap; Home and End stay with the text, as the editable-combobox pattern expects; Enter runs the active item;
  Esc closes the panel and returns focus to where it was before Ctrl K. In command mode, Enter is
  Apply and Esc is Cancel, which clears the command but keeps the panel open; a second Esc
  closes it. Tab completes the current slot with the first completion when there is one, and
  otherwise moves focus as usual. Every key is optional: every row, Apply and Cancel are
  clickable buttons.
- **IME.** Enter and Tab are ignored while `nativeEvent.isComposing` is true or `keyCode` is
  229. The first Enter after `compositionend` is ignored too, because some browsers deliver the
  Enter that confirms a 変換 after `compositionend`, with `isComposing` already false. Both
  cases are tested.
- **Clicking outside.** The panel is a non-modal Radix Popover anchored to the field, with
  `onOpenAutoFocus` prevented and no overlay, so the map stays undimmed under a preview. A
  pointer-down outside closes it. That same gesture must not also select a feature on the map,
  so the panel swallows the click that follows a closing pointer-down, with a one-shot
  capture-phase `click` listener on `window`. This is tested.
- **Announcements.** A polite `role="status"` region inside the panel reads the match count, the
  preview sentence or "Nothing matches". After Apply, the toast region (already
  `aria-live="polite"`) announces the done line, and its Undo button can be reached with the
  keyboard.
- **No new dependency.** cmdk was considered, but its filtering and item model would have to be
  switched off and wrapped around a preview pane that it does not model.

## 8. Differences from the frames

- There is no Help destination in the app, so "Help: How a project goes" is left out. The HELP
  rows that remain are per-check explanations from `issueCopy(check).why`, shown inline in the
  row.
- The hub's Next fix shows a count rather than the issue sentence, for projects that are not
  loaded (§6).
- The placeholder reads "Search stations, floors, issues, files, or type a command", without
  "features" (§10).
- Station matching uses `ProjectSummary.name` only, so `tokyo` does not find 東京駅.
- No Japanese command words (`割り当て`, `移動`). 119:193 keeps the commands in English.
- The "Understood as" chip shows `move` when the colleague typed `move`, and `assign` otherwise.
- There is no "Then you'll see" toast sample beside Apply. The toast is worded from the server's reply (§5), so the preview cannot know it in advance.
- The IME guard ignores an Enter or Tab that arrives within 100 ms of `compositionend`. A flag cleared only by the next key would swallow a deliberate Enter in Chrome, which sends no confirming Enter at all.

## 9. Tests

`parse.test.ts` is a table. Each row is an input, a fixture lexicon, and the expected `Parse`
mode and resolved ids:

- the four live strings: `東京駅 1F`, `overlap`, `JRTokyoSta_1_Opening.shp`, `assign 屋外 to 1F
  outdoor` (and `move 屋外 to 1F outdoor`);
- `１Ｆ`, `B1`, `地下1階`, `屋外to1F`, `屋外to1階` and `1F 15-16番線`, each as a slot;
- two levels named `屋外` on 1F and 2F, giving `ambiguous`, where every completion re-parses to
  one command, plus `屋外@2F` and the `#n` suffix;
- a level named `outdoor`;
- `fix_overlaps.shp` staying a search, and `fix overlap` and `fix overlaps` both parsing;
- a typo that gives `unknown`;
- `B1` against `B10F`, and `ＢＦ` against a floor labelled `B1F`, which gives no match.

The other tests cover `preview.test.ts` (assign rows, nothing-to-do, counts, at-most),
`match.test.ts` (the order of 119:193 and 117:273, extension-less filenames), the palette
(Ctrl K inside an input, IME Enter in both forms, and the outside click not reaching the map),
and pytest for `base_rev` 409 and the `with_undo` round-trip through `restore`.

## 10. Decisions from the critique

| Item | Ruling |
|---|---|
| `fix all` | Cut from v1 |
| Edit-distance matching | Not in v1; typos get prefix/substring suggestions only |
| Hiragana/katakana folding | Not in v1 |
| IME | Required: `isComposing` and the first Enter after `compositionend`, both tested |
| Ctrl K in Set up inputs; outside click on the map | Both required and tested |
| Placeholder | Drop "features" until a phase indexes feature names (decisions.md, 2026-09-25) |

## 11. Risks

- Regenerating from Set up rebuilds the features, so it overwrites an `assign` made on Check.
  That is already true of every Check edit.
- The seal on an `undo` is a plain SHA-256 with no secret, so it proves only that the payload is
  intact. This is unchanged from the fixes, and the fingerprints are what actually guard the
  data.
- Check's `content_rev` has to follow every write Check makes itself, or the colleague's own
  edit would make the next Apply fail as if someone else had changed the project. The
  single-feature PATCH and DELETE return `content_rev`, and Check takes it from their replies
  (the table editor, the venue panel and Ctrl Z). Bulk actions and fixes reload the features,
  which brings the revision with them. The client never bumps the revision itself, because an
  edit that changes nothing does not bump it on the server.
