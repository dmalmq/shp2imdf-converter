# Illustrator Placement Sidebar — Tabs and Viewport Fit — Design

Date: 2026-08-05
Status: Approved for planning
Relates to: `2026-08-05-illustrator-page-floors-design.md` (implemented, merged `66311ba`)

## Problem

On the Illustrator placement step the sidebar has grown past the fold, so the
user scrolls to reach controls. Measured in a headless Chromium at 1440 wide,
with a three-floor artwork loaded:

| Viewport height | Document scrolls by | Sidebar bottom below fold | Map height | Export button on screen |
|---|---|---|---|---|
| 720 | 490px | 474px | 1128px | no |
| 800 | 410px | 394px | 1128px | no |
| 900 | 310px | 294px | 1128px | no |
| 1080 | 130px | 114px | 1128px | no |

Two independent causes, and only the second is about content volume.

**1. The layout never constrains height.** `AppShell` is
`min-h-screen flex-col` with a content-sized `<div className="flex-1">`
(`AppShell.tsx:34`, `:70`), and the placement view is
`<div className="flex flex-1 gap-4 p-4">` (`IllustratorPage.tsx:348`). Nothing
in that chain establishes a height, so:

- the sidebar's own `overflow-auto` (`IllustratorPage.tsx:349`) can never
  engage — there is no bounded height to overflow, so the **document** scrolls
  instead of the column;
- the map is sized by its flex sibling rather than the viewport, measuring
  **1128px tall** at every viewport height above, so the map also hangs below
  the fold and the user loses map area to a column of controls.

**2. The sidebar carries 1130px of controls** against roughly 820px of usable
height at 900p (`100vh − 48px` header `− 32px` page padding).

Measured content, top to bottom:

| Card | Height | Blocks inside |
|---|---|---|
| `TransformPanel` | 469 | Undo/Redo 28 · drag/Alt/Ctrl+Z hint 48 · Floor select 51 · Find the building 50 · Rotation 70 · Scale 108 |
| `ControlPointList` | 138 | Add point, point list, Fit to control points |
| `PlacementLibrary` | 100 | Name field, Save, saved list |
| `ReferenceLayerList` | 138 | Add shapefile, layer list |
| Export block | 221 | CRS select, three format checkboxes, Export, preview count |
| **Total** | **1130** | (includes 4 × 16px gaps) |

A third, smaller finding: **floor selection exists twice.** `TransformPanel`
renders a `Floor` `<select>` (`TransformPanel.tsx:128-154`) while
`PlacementMap` renders `1F / 2F / 3F` pills over the map
(`PlacementMap.tsx:305-319`). Two controls, one job.

## Goals

- Map and sidebar both fit one screen at 720p and above, with no document
  scroll and no sidebar scroll in the normal case.
- The map fills the available viewport height instead of being sized by the
  sidebar.
- The controls the user reaches for repeatedly stay permanently visible.
- Overflow, when content genuinely grows (many control points, many reference
  layers), is contained inside one scrollable region and can never move the
  page again.

## Non-goals

- Changing any placement behaviour, transform maths, or export output. This is
  layout and information architecture only.
- Redesigning the map overlays (basemap switcher, transform gizmo) beyond the
  one floor-pill change below.
- Touching the review page, which `AppShell` already bypasses
  (`AppShell.tsx:29-31`).
- A general-purpose tab system for the whole app. One local, accessible tab
  component, placed in `components/ui/` only if a second consumer appears.

## Decisions

The split between pinned and tabbed comes from the user naming which controls
they touch repeatedly while watching the map: **rotation, scale, floor
switching, and the building search**. Scale was then withdrawn on reflection —
drawing scale is a property of the source file, set once from the known
`1:1000`, whereas rotation is a judgement made against the basemap. Undo/Redo
were not named, consistent with the keyboard shortcuts the hint text
advertises.

| Question | Decision |
|---|---|
| Height constraint | The shell becomes a fixed-height flex row (`100vh − 48px` header) with a `min-h-0` chain, so children scroll internally instead of growing the page |
| Pinned block | Undo/Redo (icon-only), Find the building, Rotation, plus the conditional relink action |
| Tabs | **Scale & fit** · **Reference** · **Export** |
| Floor switching | Map pills become the single control; the sidebar `<select>` is deleted |
| Overflow of last resort | The tab panel is `flex-1 min-h-0 overflow-auto`; nothing else in the column scrolls |
| Tab persistence | Local React state in `IllustratorPage`, default `Scale & fit`. Not persisted across reloads |

### Tab contents and why

- **Scale & fit** — metres-per-point, the `1:N` drawing scale with Apply, the
  `pt = m` Calibrate pair, the control-point list, and Fit to control points.
  These belong together because every one of them *derives the transform
  numerically*; Calibrate and Fit both literally compute scale.
- **Reference** — the underlay shapefiles from `ReferenceLayerList`, whose own
  help text describes them as drawn under the artwork to align against.
  Deliberately **not** labelled "Layers": this app already uses "layer" for
  Illustrator layers (`ai_layer`, the layer restriction on the assign screen),
  so "Layers" would collide with an existing domain term.
- **Export** — saved placements, output CRS, format checkboxes, the Export
  button and the preview-count line. The end-of-job tab.

### Target structure

```
┌─ header 48px (unchanged) ────────────────────────────────────┐
├──────────────────────────┬───────────────────────────────────┤
│ ⟲ ⟳                  (?) │                                   │
│ Find the building        │                                   │
│ [新宿駅            ][⌕]  │   map fills the viewport height   │
│ Rotation (true north)    │  ┌────────┐                       │
│ [ 0 ]°  Reset            │  │1F 2F 3F│ ← single floor control│
│ ── (relink, if unlinked) │  └────────┘                       │
├──────────────────────────┤                                   │
│ ┌Scale & fit┬Reference┬Export┐                               │
│ │                          │ │                               │
│ │  · · · active panel · · ·│ │                               │
│ │  flex-1, min-h-0,        │ │                               │
│ │  overflow-auto           │ │                               │
│ └──────────────────────────┘ │                               │
└──────────────────────────┴───────────────────────────────────┘
```

### Height budget

| Region | Height |
|---|---|
| Pinned block incl. card padding, with the hint compressed to one line | ~250 |
| Tab strip | ~36 |
| Tallest panel (Export: saved placements + CRS + formats + button + count) | ~290 |
| Gaps | ~12 |
| **Total** | **~602** |

Usable height is 640px at 720p and 820px at 900p, so the column fits at every
height measured, with the panel absorbing any growth internally.

## The two folded-in recommendations

### 1. Compress the interaction hint

`TransformPanel.tsx:122-127` spends 48px of permanent height on three lines of
prose covering drag, Alt-drag, corner scale, top-handle rotate, `Ctrl+Z` /
`Ctrl+Shift+Z`, and arrow-nudge with Shift. It is read once and then occupies
that space forever.

It becomes a single line — drag to move, corners scale, top handle rotates —
with the full text behind a `?` button beside Undo/Redo, rendered as a native
popover so it cannot be clipped by an `overflow` ancestor. Both the short and
long strings stay bilingual through `t()`. Nothing is deleted; the detail moves
one click away.

### 2. Delete the sidebar floor dropdown, without losing what it carried

The `<select>` is redundant with the map pills — one click instead of two, and
positioned where the user is already looking. But the section around it carries
two things the pills do not, and both must survive:

- **`Relink to shared frame`** (`TransformPanel.tsx:143-152`), shown only when
  the active floor is unlinked. It moves into the pinned block, still
  conditional, so it costs 0px whenever every floor is linked.
- **The `(unlinked)` marker** that the `<option>` label appended
  (`TransformPanel.tsx:139`). The pills render `floor.label` only
  (`PlacementMap.tsx:315`), so this information would otherwise disappear. The
  pills gain a 4px dot before the label when that floor is unlinked — a shape
  change, not a colour alone, so it survives a colour-vision deficiency, plus a
  `title` carrying the same word the dropdown used. This is the one deliberate
  addition to the map overlays.

Note that the rotation block already surfaces unlinked state for the *active*
floor via its `(this floor)` suffix (`TransformPanel.tsx:210-212`), and that
block stays pinned; the pill marker covers the *other* floors at a glance.

## Implementation shape

| File | Change |
|---|---|
| `components/shell/AppShell.tsx` | `min-h-screen` → `h-screen`; the content wrapper becomes `flex-1 min-h-0 overflow-auto` so every existing route scrolls *inside* the wrapper rather than clipping |
| `pages/IllustratorPage.tsx` | Placement view becomes a bounded flex row; sidebar becomes pinned block + `PlacementTabs`; the inline export block moves into the Export panel |
| `components/illustrator/TransformPanel.tsx` | Splits: pinned pieces stay, Scale moves to the Scale & fit panel, floor `<select>` deleted, relink kept conditional, hint compressed |
| `components/illustrator/PlacementMap.tsx` | Floor pills gain the unlinked marker |
| `components/ui/Tabs.tsx` (new) | Accessible tab primitive |

Only the placement view is bounded; the upload and assign views keep their
current centred-card layout, which scrolls legitimately when the page grid is
tall.

### Tab component contract

```tsx
type TabsProps = {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
};
```

Accessibility is not optional here, since this becomes the primary navigation
of the placement step:

- `role="tablist"` on the strip, `role="tab"` per trigger with `aria-selected`
  and `aria-controls`, `role="tabpanel"` with `aria-labelledby` on the panel.
- Roving `tabIndex`: the active tab is `0`, the rest `-1`; Left/Right move
  between tabs, Home/End jump to first/last.
- Focus ring reusing the existing convention —
  `focus-visible:ring-2 focus-visible:ring-offset-1` with
  `--color-primary`, matching `Button.tsx:36`.
- **All three panels stay mounted; the inactive ones are `hidden`.** Unmounting
  on switch would lose real state, verified by reading each panel:
  `TransformPanel`'s scale block holds `denominator`, `artworkDistance` and
  `realMetres` (`TransformPanel.tsx:41-43`) so a typed `1:500` would reset;
  `PlacementLibrary` holds a typed `name` plus a fetched `placements` list and
  fetches on mount (`PlacementLibrary.tsx:39-54`), so every visit to Export
  would refetch and discard a half-typed building name;
  `ReferenceLayerList` holds `loading` and `error` (`:24-25`), so an upload
  failure message would vanish mid-read. `hidden` keeps the ARIA contract
  correct — a hidden panel is out of the accessibility tree, so only the active
  one is exposed — and the cost is a handful of inputs rendering off-screen.
  Fetching the placement list once on arrival rather than per tab visit is also
  the better behaviour.

### Visual treatment

Follow the existing system rather than inventing one: `--color-border` for the
strip rule, `--color-primary` for the active tab, `--color-text-secondary` for
inactive labels, `--radius-md`, and the existing `text-xs font-medium` used by
every current panel heading. The active tab is marked by a 2px underline in
`--color-primary` plus the ink shift to `--color-text`; the underline, not
colour alone, carries the state. Panel headings (`Control points`,
`Saved placements`, `Reference layers`) stay as sub-headings inside their
panels, since two of the three panels hold more than one block.

No new colours, no card nesting — the tab strip and panel share the single
existing `Card`, because a card inside a card is never right.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| One floor only | Map pills already hide themselves (`floors.length > 1`); nothing else changes, and no floor control appears anywhere — matching today |
| Active floor unlinked | Relink button appears in the pinned block; pill shows the unlinked marker; rotation keeps its `(this floor)` suffix |
| Many control points | The Scale & fit panel scrolls internally; the page does not |
| Many reference layers | Same, in the Reference panel |
| Long search-result list | Already capped at `max-h-40 overflow-auto` (`TransformPanel.tsx:180`) inside the pinned block; unchanged |
| Viewport below 720p tall | The panel scrolls internally; the map still fills its share and the page still does not scroll |
| Narrow viewport | Out of scope: this view is desktop-only today (fixed `w-80` sidebar) and stays so |

## Testing

The existing suite has no coverage of the placement view's layout, and layout
is what changes, so verification is primarily measured behaviour rather than
new unit tests.

Component tests (vitest + `@testing-library/react`, `globals: true`, and
`import React` since the vitest config has no React plugin):

- `Tabs`: renders one `role="tab"` per entry with correct `aria-selected`;
  clicking a tab calls `onChange`; Left/Right/Home/End move the active tab;
  exactly one `role="tabpanel"` is present.
- `TransformPanel`: no `Floor` `<select>` is rendered even with three floors;
  the relink button appears only when the active floor is unlinked; the short
  hint renders and the long text is reachable from the `?` control.

Measured verification in a browser, which is the actual acceptance criterion —
these are the numbers the problem statement was built from, so they are
re-measured the same way:

- At 720, 800, 900 and 1080 viewport heights: `documentElement.scrollHeight`
  equals `clientHeight` (no document scroll), the sidebar column's
  `scrollHeight` equals its `clientHeight` (no sidebar scroll), the Export
  button is inside the viewport, and the map's height is within a few pixels
  of `viewport − 48 − 32`.
- Switching tabs keeps all three of the above true.
- Adding several control points makes the Scale & fit panel scroll while the
  document still does not.

Regression: `npx tsc -b` clean, the full `vitest` suite green, and
`pytest -q` untouched at 311 since no backend file changes.

## Risks

| Risk | Mitigation |
|---|---|
| Bounding `AppShell` to `h-screen` affects other routes | The content wrapper is `flex-1 min-h-0 overflow-auto`, so any route whose content exceeds the viewport scrolls inside the wrapper exactly as the document scrolled before — visually identical, never clipped. Only the placement view opts into `overflow-hidden` on itself to claim a bounded height. The review page bypasses `AppShell` entirely (`AppShell.tsx:29-31`). Each remaining route is checked for a double scrollbar |
| Deleting the floor `<select>` loses the unlinked signal | Explicitly replaced by the pill marker plus the retained relink button; called out as a required part of the change, not a follow-up |
| Tabs hide a control the user actually needs mid-drag | The pinned set was chosen by the user naming their own hot controls, and scale was moved out at their request. If it proves wrong, the pinned/tabbed boundary is a single list to edit, not a restructure |
| Three tab labels may not fit a 320px column | Labels are short and `text-xs`; measured in the browser during implementation, and the bilingual Japanese labels are shorter still. If English overflows, `Scale & fit` shortens to `Fit` |
| Panel remount loses in-progress input | Real, and the reason panels stay mounted behind `hidden` rather than unmounting: all three hold local state that a switch would discard (typed drawing scale and calibrate pair, typed placement name, upload error), and `PlacementLibrary` would refetch on every visit |
