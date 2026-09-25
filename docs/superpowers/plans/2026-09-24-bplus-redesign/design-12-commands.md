# Design: search and commands (phase 12)

Back to [overview](overview.md) · [phase 12](phase-12-search.md). Status: draft for critique,
2026-09-25. Nothing here is implemented yet.

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
  then a sentence in Fraunces, a paragraph on what moves with it, and a before → after table
  (Floor, Ordinal, Outdoor). A follow-up line says the changed floors are checked again. Below
  that are Apply (Enter), Cancel (Esc) and "Then you'll see: Moved 屋外 to 1F. Undo". An "Or
  did you mean" section offers a go-to item and a floor item, and the footer reads "Typed
  commands and buttons do the same thing, and both can be undone · Tab completes". The map
  outlines where the features will land, and it is not dimmed.
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
  | { kind: "navigate"; to: string }                 // route, may carry ?floor= / ?issue=
  | { kind: "page"; invoke: () => void }             // a handler the page on screen registered
  | { kind: "command"; command: Command }            // opens the preview; never applies directly
  | { kind: "disabled"; reason: Bilingual };

type SearchItem = {
  id: string;                  // stable per source, e.g. "floor:1F", "issue:overlapping_units:<fid>"
  kind: SearchKind;
  tone?: "help";               // the frame's HELP chip, still in the Actions group
  label: Bilingual;
  detail: Bilingual;
  hint?: Bilingual;            // "Continue", "Open on the map", "Go to 1F"
  badge?: { text: Bilingual; tone: "danger" | "warning" };  // "3 to fix"
  run: Run;
  /** Pre-normalised match strings (names in every language, stems, check ids). Built once per source revision. */
  terms: readonly string[];
};
```

The phase plan's `{ kind, label, detail, run }` is kept. `run` is a tagged value rather than a
thunk, so the panel can tell navigate from preview from disabled without calling anything, and
tests can assert on it.

The typed command language:

```ts
type Verb = "go" | "assign" | "fix";

type FloorRef = { label: string; ordinal: number; levelIds: readonly string[] };       // a buildFloorGroups entry
type LevelRef = { featureId: string; name: string; floor: FloorRef; outdoor: boolean };

type Place =
  | { kind: "station"; projectId: string; name: string; floor?: string }  // floor unresolved when the project is not loaded
  | { kind: "floor"; floor: FloorRef }                                    // a floor of the loaded project
  | { kind: "stage"; stage: ShapefileStageId };

type Command =
  | { verb: "go"; place: Place }
  | { verb: "assign"; level: LevelRef; to: FloorRef; outdoor: "set" | "clear" | "keep" }
  | { verb: "fix"; scope: "overlaps" | "all" };
```

A `Command` only exists once every slot has been resolved against the loaded data. Everything
short of that is a `Parse`, not a `Command`:

```ts
type Slot = "place" | "level" | "floor" | "flag" | "scope";

type Parse =
  | { mode: "search"; terms: readonly string[] }                  // first word is not a verb
  | { mode: "command"; command: Command; tokens: readonly Token[] } // chips for "Understood as"
  | { mode: "incomplete"; verb: Verb; expecting: Slot; completions: readonly Completion[] }
  | { mode: "ambiguous"; verb: Verb; slot: Slot; text: string; candidates: readonly Completion[] }
  | { mode: "unknown"; verb: Verb; slot: Slot; text: string; nearest: readonly Completion[] };

type Completion = { insert: string; label: Bilingual; detail: Bilingual };
```

A preview is pure data, derived from a `Command` and a snapshot:

```ts
type Preview =
  | { kind: "navigate"; sentence: Bilingual; to: string }
  | { kind: "nothing-to-do"; sentence: Bilingual }                 // e.g. 屋外 is already on 1F and outdoor
  | { kind: "unavailable"; sentence: Bilingual; reason: Bilingual; instead?: SearchItem }
  | {
      kind: "change";
      sentence: Bilingual;                       // "Move the 屋外 level onto floor 1F and mark it as outdoor."
      consequence: Bilingual;                    // "Its 2 plazas — … — move with it …"
      rows: readonly { field: Bilingual; before: string; after: string }[];
      followUp: Bilingual;                       // "Afterwards, 0F and 1F are checked again …"
      done: Bilingual;                           // "Moved 屋外 to 1F." — the toast and the Done row
      highlight: readonly string[];              // feature ids the map outlines
      certainty: "exact" | "at-most";            // fix previews count candidates, not outcomes
      basis: number;                             // the snapshot revision it was computed from
    };
```

`unavailable` always carries a reason. `change` always carries its before and after values.
There is no preview that can be applied but has nothing to show.

## 2. Grammar and tokenisation

```
input    := command | search
command  := verb (SP args)?
verb     := "go" | "assign" | "fix"                    (English in both UI languages, as 119:193 shows)
go       := place
place    := station [floor] | floor | stage
assign   := level SP? "to" SP? floor (SP flag)?
flag     := "outdoor" | "indoor"
fix      := "overlaps" | "all"
stage    := "bring-in" | "bring in" | "set-up" | "set up" | "check" | "deliver"
```

**Normalisation.** Input and every term go through the same `norm()`: NFKC, so `１Ｆ` becomes
`1F`, `ｅｘｐｏｒｔ` becomes `export` and U+3000 becomes a space. Then lower-case, collapse
whitespace, and treat `・ · _ -` as word breaks for matching only; a filename keeps its own
characters for display. Floor labels also get a canonical key so that `1F`, `1f`, `1階`, `B1`,
`B1F` and `地下1階` meet: `^(b|地下)?(\d+)(f|階)?$` becomes `1F` or `B1F`. The alias applies to
floor names only.

**Slots come from the lexicon, not from whitespace.** After the verb, the parser takes the
longest known name that is a prefix of the remaining text. It tries level names, then floor
labels, then station names, depending on the slot. Then it expects the connective or the next
slot. This gives four properties:

- `assign 屋外 to 1F outdoor` resolves to level 屋外, connective `to`, floor 1F, flag outdoor.
- `assign 屋外to1F` works as well. Japanese is typed without spaces, and `to` is only
  recognised as a word where a Latin letter does not continue it.
- A name with spaces in it, such as 新宿's `1F 15-16番線`, is a single slot, because the longest
  match wins over the space.
- `1F屋外` (新宿) and `屋外` (a 2F level) are different lexicon entries. Typing `屋外` matches
  both as prefixes, so the result is `ambiguous`, with both levels offered as candidates
  ("Or did you mean"). The parser never picks one silently.

Text that matches nothing becomes `unknown`, with the nearest names (prefix, then substring)
offered as `nearest`.

**Search mode** is used whenever the first word is not a verb. That covers `東京駅 1F`,
`overlap`, `JRTokyoSta_1_Opening.shp` and `export`. The query is split on whitespace. A term
that mixes scripts and matches nothing whole (`東京駅1F`) is split again at CJK/Latin
boundaries. An item matches when it covers at least one term. The score is the number of terms
covered, then the match quality (exact, then prefix, then word-prefix, then substring). Items of
the loaded project carry its station name as a term, so `東京駅 1F` puts the floor, which
covers both terms, above the station, which covers one. That is 119:193's order. Groups are
ordered by their best item, and ties go Stations, Floors, Issues, Files, Actions. There are at
most 5 items per group. A filename matches with or without its extension.

`export` and `deliver` are not verbs. They are keywords on the Deliver action ("export ·
deliver" in 120:2), so they stay in search mode and never open a command preview.

### Parser alternatives

| | A. Whitespace tokens + recursive descent | **B. Verb table + lexicon-driven longest match** (recommended) | C. PEG / parser-combinator library (peggy, parsimmon) |
|---|---|---|---|
| Japanese without spaces (`屋外to1F`, `東京駅1F`) | Fails, or needs heuristic splitting that breaks `1F屋外` | Works: slots are found by name, not by space | Only if the grammar embeds the lexicon, which means regenerating it per project |
| Names with spaces (`1F 15-16番線`) | Needs quoting, which nobody types | Works (the longest match wins) | Same problem as A unless the lexicon is injected |
| Ambiguity (`屋外` vs `1F屋外`) | Invisible: the first token wins | Explicit `ambiguous` state with candidates | Possible, but the library reports parse errors, not candidates |
| Completion (Tab) | Hand-built | Free: the unmatched remainder is a prefix query on the slot's lexicon | Hand-built on top of error positions |
| Cost | Smallest code | About 200 lines, pure, table-testable | New dependency, and the grammar lives outside TS types |

**B**, because the hard cases here are all about names: Japanese without spaces, names with
spaces, and names that are prefixes of other names. The grammar has three verbs, so a grammar
library does not pay for itself. With B the parse is a pure function
`parse(input, lexicon): Parse`, and the phase's parser table tests call it with a fixture
lexicon.

## 3. Initial verbs

Each verb that changes data goes through an endpoint that already exists. Only `go`, which
changes nothing, stays client-only.

| Verb | Example | Endpoint | Where it can apply |
|---|---|---|---|
| `go` | `go 東京駅 1F`, `go check`, `go 屋外` | none (navigation; floor and issue ride as `?floor=` / `?issue=` hints Check reads once on arrival) | anywhere; stages respect `stageReachable` |
| `assign` | `assign 屋外 to 1F outdoor` | `PATCH /api/session/{id}/features/bulk` (`action: "patch"`, the level's id, `properties: {ordinal, short_name, outdoor}`) | Check, with features loaded |
| `fix` | `fix overlaps`, `fix all` | `POST …/overlaps/fix-safe`; `POST …/autofix` with `apply_prompted: false` | Check |

`assign` does what 117:614 describes. It gives the level the target floor's ordinal and
`short_name`, and sets `outdoor` when a flag is typed. Units, openings and amenities point at
the level by `level_id`, so they move without being touched, and the preview counts them.
Outside Check, the preview is `unavailable` ("Open 東京駅's Check to move levels"), with a `go`
item as `instead`. It does not fall through to `PATCH /wizard/levels`: Set up autosaves its own
drafts, and a second writer would race them.

Left out of the first set, as candidates for later: `select` (Check's filters already do it),
`rename`, the keep-A / keep-B overlap choice (the "Resolve the overlap" action opens the
existing issue popover instead), and the prompted autofix (it asks for confirmation, and that
belongs to the page's own dialog).

## 4. Preview without side effects

`preview(command, snapshot): Preview` is a pure function. The snapshot is the immutable data
the page has registered (§6): features, validation, floor groups and a `revision` that the page
bumps whenever it replaces any of them. The function makes no request, writes nothing to the
store and does not touch the map.

- **assign** reads the level's current ordinal, short_name and outdoor values, and the target
  floor's values, from the snapshot. It counts the features whose `level_id` is the level's id,
  by type, for the consequence line. The rows are Floor, Ordinal and Outdoor. `highlight` is the
  level plus those features. When nothing would change, the result is `nothing-to-do`.
- **fix overlaps** counts distinct `overlapping_units` pairs in the stored validation. Which
  pairs the server finds clear-cut is decided in `_choose_safe_overlap_resolution`, so the
  preview is `certainty: "at-most"` ("Trims up to 4 overlaps; any that need your choice stay on
  the list"). **fix all** lists the `auto_fixable` issues with their `fix_description`, also
  `at-most`. With no current validation (checks stale), the preview is `unavailable` ("Run the
  checks first"), with Run the checks as `instead`.

The map outline is view state, not data. The panel passes `preview.highlight` to the page's
`showPreview(ids | null)` hook and clears it on Cancel, Esc, close and Apply.

Apply re-checks `basis === snapshot.revision`. If the page has moved on, for example after a
reload, another fix, or an edit in the table, Apply is not sent. The preview is recomputed and
shown again with "This changed while you were looking; here it is again".

## 5. Apply and Undo reuse Check's fix path

Check already has one path for every fix. `applyFix(request, label, failure)` applies the
revalidation, reloads the features, and records `{label, undo}` in the Done list. `undoFix`
sends that `undo` back through `PATCH …/features/bulk` `action: "restore"`, which is guarded by
the fingerprints and seal (409 `UNDO_STALE`, 400 `UNDO_INVALID`). Commands add no second path:

- **fix overlaps / fix all** call the same `resolveSessionUnitOverlapsSafe` and `autofixSession`
  requests through `applyFix`, with `preview.done` as the label. Undo is the existing Done row.
- **assign** calls `patchSessionFeaturesBulk` through `applyFix`. The bulk `patch` action
  returns no `undo` today. **The one backend change** is that it builds one with the existing
  `finish_fix(before, after)` and returns it in an additive `undo` field on
  `BulkPatchFeaturesResponse`, the same shape and seal the fixes return. The client then runs
  the existing `POST /validate` (the `followUp` line) and records the Done row. Undo is the
  existing restore, with its guard.
  - Rejected alternative: undo by sending the old properties back as a second patch. It needs
    no backend change, but it has no fingerprint guard, so an edit from another tab or the table
    would be overwritten silently. Decision 2026-09-25 (Undo for Check's fixes) exists to
    prevent exactly that.
  - Rejected alternative: pushing onto `editHistory` (Ctrl Z). It is single-feature and
    unguarded, and Ctrl Z on Check already means "undo the last table edit".
- After Apply, the panel closes and a toast says `preview.done`, with an Undo button that calls
  the page's `undoFix` for that Done row. Toasts have no action today, so a single optional
  `action` prop is added to `ToastProvider`. The Done list stays the permanent place to undo,
  and `undoable()` still withdraws Undo once a later fix touches the same features.

## 6. Where search data comes from, and what it costs

| Source | Feeds | How | Cost |
|---|---|---|---|
| `GET /api/projects?flow=shapefiles` | Stations, Recent stations, the hub's Next fix, Deliver's badge | fetched when the panel **opens**, shown from the last copy at once and replaced when the reply lands | one index-only request per open; it never touches a session (design-05-06 §2) |
| Store: `files`, `wizardState.levels`, `loadedSessionId` | Files, and Floors before Check | read directly; the hub keeps the last project in the store, so its files are searchable there too | none |
| Check's registration: features (levels only), validation, floor groups, `revision`, `openIssue`, `setFloor`, `applyFix`, `undoFix`, `showPreview` | Floors, Issues, Next fix, the command snapshot | `useSearchSource(source)` puts it in a new shell slot, like `usePageShell` does; the page already holds all of it in memory | none |
| Static | Actions, stage names, verbs, check copy (`issueCopy`) | module constants | none |

**Nothing per keystroke touches the network.** Every search runs in memory over an index that
is rebuilt only when a source's identity changes (memoised per source). Each item's `terms`
are normalised at build time. A keystroke normalises the query and scans a few hundred items at
most: 新宿 has about 15 floors, up to a few hundred issues, around 50 files, up to 200 stations
and about 10 actions. `useDeferredValue` keeps typing ahead of rendering. Unit and amenity names
are not indexed in this phase (see §8).

**Other projects' floors, issues and files are not fetched.** Every per-session GET goes through
`get_session_or_raise`, which touches `last_accessed`. Looking into 新宿 from the search panel
would therefore count as opening it: it would reorder the hub and extend 新宿's 30-day life.
Because of that:

- On the hub, **Next fix** for a project that is not loaded shows the summary's count ("東京駅 ·
  3 things before you can deliver") and opens its Check, which focuses the first must-fix issue.
  The frame's issue sentence appears only for the project that Check has loaded.
- On the hub, `東京駅 1F` for a project that is not loaded gives the item "東京駅 · 1F", which
  opens `/p/:id/check?floor=1F`. Check applies the hint if that floor exists and otherwise says
  "No floor 1F in 東京駅" once. Files of the project the store still holds are searchable.
- "All stations" in the scope line narrows the panel to the Stations group. It does not fetch
  anything.

## 7. Keyboard and accessibility

- **Open.** Ctrl K (⌘K on macOS) from anywhere, including inside other inputs, with
  `preventDefault` so the browser's own Ctrl K is suppressed. Clicking the field also opens it.
  The field is the resting top-bar input with the `Ctrl K` kbd hint, replacing the empty
  `data-slot="search"`.
- **Pattern.** ARIA 1.2 combobox with a listbox popup. The input has `role="combobox"`,
  `aria-expanded`, `aria-controls` and `aria-activedescendant`, and focus never leaves it while
  the user moves through results. Each group is `role="group"` with `aria-labelledby` pointing
  at its heading, and each row is `role="option"` with `aria-selected`. The kind chip is inside
  the option's name ("Floor, 東京駅 · 1F, 1 overlap left").
- **Keys.** ↑ and ↓ move and wrap; Home and End jump to the ends; Enter runs the active item;
  Esc closes the panel and returns focus to where it was before Ctrl K. In command mode the
  preview replaces the list: Enter is Apply, Esc is Cancel (back to the typed text, not closed),
  and a second Esc closes. Tab completes the current slot when there is a completion and
  otherwise moves focus as usual, so it never traps. Every key is optional ("keys optional"):
  every row, Apply and Cancel are clickable buttons.
- **IME.** Enter and Tab are ignored while `event.isComposing` is true (or `keyCode === 229`).
  Otherwise, the Enter that confirms a 変換 would run the top result.
- **Announcements.** A polite `role="status"` region inside the panel reads "4 matches", or the
  preview sentence when a command resolves, or "Nothing matches". After Apply, the existing
  toast region (already `aria-live="polite"`) announces the done line, and its Undo button can
  be reached with the keyboard.
- **Not modal.** The panel is a non-modal Radix Popover anchored to the field, with
  `onOpenAutoFocus` prevented. It has no overlay, so the map stays undimmed and visible under a
  preview, as the design notes require. It closes on an outside click.
- **No new dependency.** cmdk was considered. Its own filtering and item model would have to be
  switched off (`shouldFilter={false}`) and wrapped around a preview pane that it does not model.
  The combobox is about 150 lines on the Popover that is already installed.

## 8. Differences from the frames (proposed)

- There is no Help destination in the app, so the empty state leaves out "Help: How a project
  goes". The HELP rows that remain are per-check explanations from `issueCopy(check).why`,
  shown inline in the row.
- The hub's Next fix shows a count rather than the issue sentence, for projects that are not
  loaded (§6).
- The placeholder "Search stations, floors, features, or type a command" promises feature
  names, but the frames have no Features group. **Question for Daniel:** either index named
  units and amenities under Floors ("中央通路 · 1F") in this phase, or drop "features" from the
  placeholder until a later phase adds them. The recommendation is to drop the word for now.
- Station matching uses `ProjectSummary.name` only, so `tokyo` does not find 東京駅. There is no
  English or romanised name in the listing.
- The Japanese command words (`割り当て`, `移動`) are not added. 119:193 keeps the commands in
  English, and new Japanese grammar would need the same native review as the copy.

## 9. Risks

- Regenerating from Set up rebuilds the features, so it overwrites an `assign` made on Check.
  That is true of every Check edit today. The preview's follow-up line could say so if the
  critique wants it.
- `short_name` is multilingual. `assign` copies the target floor's whole label object, not one
  language, so ODC's per-floor tokens stay consistent.
- The seal on an `undo` is a plain SHA-256 with no secret, so it proves only that the payload
  is intact, not where it came from. This is unchanged from the fixes, and the fingerprints are
  what actually guard the data.
- A lexicon built from real data can contain names that collide with verbs or flags (a level
  called `outdoor`). The longest-match-by-slot rule decides these cases, and the table tests
  include them.
