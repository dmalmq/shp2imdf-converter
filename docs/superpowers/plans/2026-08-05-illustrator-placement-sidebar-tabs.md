# Illustrator Placement Sidebar Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Illustrator placement map and sidebar fit one screen at 720p and above with no scrolling, by bounding the layout to the viewport and moving the cold controls behind three tabs.

**Architecture:** Two independent changes. First the shell gains a real height: `AppShell` becomes `h-screen` with a `flex-1 min-h-0 overflow-auto` content wrapper, and the placement view claims a bounded height with `overflow-hidden`, so the map fills the viewport and any overflow stays inside the sidebar instead of moving the document. Second the sidebar splits into a pinned block (Undo/Redo, building search, rotation, conditional relink) and a tab strip over three panels — **Scale & fit**, **Reference**, **Export**. All three panels stay mounted behind `hidden`, because each holds local state a remount would discard.

**Tech Stack:** React 18 + TS, Tailwind utility classes against the existing CSS custom-property tokens in `frontend/src/index.css`, vitest + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-08-05-illustrator-placement-sidebar-tabs-design.md`

## Global Constraints

- Every user-facing string is bilingual via `useUiLanguage().t(english, japanese)`. A monolingual string is a defect — this app serves Japanese rail-station floor plans.
- Frontend tests: `globals: true`, so do NOT import `test`/`expect` from vitest. Test files DO need `import React from "react"` — `vitest.config.ts` has no React plugin, so the classic JSX transform applies, and test files sit outside `tsconfig.app.json` so `tsc -b` cannot catch a missing import.
- `npx tsc -b` must exit 0 on every commit. `noUnusedLocals` is on (`tsconfig.app.json`), so an unused import fails the build.
- **NEVER use `: any` or `as any`.** Use `unknown`, a domain type, a generic, or a type guard. This is an enforced project rule.
- No behaviour change to placement maths, transforms, or export output. This is layout and information architecture only.
- Reuse the existing components and tokens: `Card`, `Button` (variants `primary | secondary | ghost | danger`, sizes `sm | md | lg`), `--color-border`, `--color-primary`, `--color-text`, `--color-text-secondary`, `--color-text-muted`, `--radius-md`, `--radius-lg`. Introduce no new colours.
- No card nested inside a card. The tab strip and the active panel share one `Card`.
- Do NOT run formatters or linters. Do NOT touch backend files — `pytest` must stay at 311 untouched.
- Baseline before this plan: `tsc -b` exit 0, 118 frontend tests in 10 files, 311 backend tests.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `frontend/src/components/ui/Tabs.tsx` | Accessible tab strip: `role="tablist"`, roving tabindex, arrow/Home/End keys. Renders the strip only; the caller owns the panels |
| `frontend/src/components/ui/Tabs.test.tsx` | Tab behaviour and ARIA wiring |
| `frontend/src/components/illustrator/ScaleAndFitPanel.tsx` | The Scale block moved out of `TransformPanel`, plus `ControlPointList` |
| `frontend/src/components/illustrator/ExportPanel.tsx` | `PlacementLibrary`, output CRS, format checkboxes, Export button, preview count, error line |

**Modify**

| File | Change |
|---|---|
| `frontend/src/components/shell/AppShell.tsx` | `min-h-screen` → `h-screen`; content wrapper → `flex-1 min-h-0 overflow-auto` |
| `frontend/src/pages/IllustratorPage.tsx` | Placement view bounded; sidebar becomes pinned block + tabs + three `hidden`-toggled panels; inline export JSX moves to `ExportPanel` |
| `frontend/src/components/illustrator/TransformPanel.tsx` | Floor `<select>` deleted, relink kept conditional, hint compressed behind a `?` popover, Scale section removed |
| `frontend/src/components/illustrator/TransformPanel.test.tsx` (new file, but grouped here) | Covers the pinned-block changes |
| `frontend/src/components/illustrator/PlacementMap.tsx` | Floor pills gain an unlinked dot + `title` |

---

## Task 1: Bound the layout to the viewport

**Files:**
- Modify: `frontend/src/components/shell/AppShell.tsx:34`, `:70`
- Modify: `frontend/src/pages/IllustratorPage.tsx:348`, `:349`, `:410`

**Interfaces:**
- Consumes: nothing new.
- Produces: a height-bounded placement view. The sidebar column becomes the only scrollable region in that view; the map's height equals `viewport − 48 (header) − 32 (page padding)`.

This task alone removes the document scroll and resizes the map, before any tab work. It is independently verifiable.

- [ ] **Step 1: Bound the shell**

In `frontend/src/components/shell/AppShell.tsx`, replace line 34:

```tsx
    <div className="flex h-screen flex-col bg-[var(--color-surface-muted)]">
```

and replace the content wrapper at lines 70-72:

```tsx
      {/* ─── Page content ─── */}
      {/* min-h-0 lets a bounded child own the remaining height; overflow-auto
          keeps every other route scrolling inside the wrapper exactly as the
          document scrolled before, rather than clipping. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {children}
      </div>
```

- [ ] **Step 2: Bound the placement view**

In `frontend/src/pages/IllustratorPage.tsx`, replace line 348:

```tsx
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
```

and replace line 349 (the sidebar column):

```tsx
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-auto">
```

`overflow-auto` here, not `overflow-hidden`: this task must leave a usable app.
With a bounded parent the column now genuinely scrolls internally — already a
large improvement over scrolling the whole document, and the Export button stays
reachable. Task 5 switches this to `overflow-hidden` once the tab panel owns the
one scroll region.

Replace line 410 (the map wrapper) — `min-h-[600px]` would force overflow on a
short viewport, which is exactly what this task removes:

```tsx
      <div className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border">
```

- [ ] **Step 3: Verify the shell change did not clip another route**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: exit 0, 118 tests still passing (no test covers layout, so this is a regression check only).

Then check the two other routes that use `AppShell` still scroll rather than clip. The review page bypasses `AppShell` entirely (`AppShell.tsx:29-31`) so it is unaffected.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/shell/AppShell.tsx frontend/src/pages/IllustratorPage.tsx
git commit -m "fix: bound the placement view to the viewport height"
```

---

## Task 2: Accessible tabs primitive

**Files:**
- Create: `frontend/src/components/ui/Tabs.tsx`
- Create: `frontend/src/components/ui/Tabs.test.tsx`
- Modify: `frontend/src/components/ui/index.ts`

**Interfaces:**
- Produces:
  ```tsx
  export type TabDefinition = { id: string; label: string };
  export function Tabs(props: {
    tabs: TabDefinition[];
    active: string;
    onChange: (id: string) => void;
    /** Prefix for the generated `id`/`aria-controls` pair. */
    idPrefix: string;
    className?: string;
  }): JSX.Element;
  export function tabPanelProps(idPrefix: string, id: string, active: boolean): {
    id: string;
    role: "tabpanel";
    "aria-labelledby": string;
    hidden: boolean;
  };
  ```
  `Tabs` renders only the strip. The caller renders panels and spreads
  `tabPanelProps(...)` onto each, which is what keeps every panel mounted while
  exposing only the active one.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/Tabs.test.tsx`:

```tsx
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { Tabs, tabPanelProps, type TabDefinition } from "./Tabs";


const TABS: TabDefinition[] = [
  { id: "fit", label: "Scale & fit" },
  { id: "reference", label: "Reference" },
  { id: "export", label: "Export" }
];

function Harness() {
  const [active, setActive] = useState("fit");
  return (
    <div>
      <Tabs tabs={TABS} active={active} onChange={setActive} idPrefix="p" />
      {TABS.map((tab) => (
        <div key={tab.id} {...tabPanelProps("p", tab.id, tab.id === active)}>
          panel {tab.id}
        </div>
      ))}
    </div>
  );
}


test("renders one tab per definition with the active one selected", () => {
  render(<Harness />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs).toHaveLength(3);
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  expect(tabs[1]).toHaveAttribute("aria-selected", "false");
});

test("each tab controls the panel labelled by it", () => {
  render(<Harness />);
  const tab = screen.getAllByRole("tab")[1];
  const panelId = tab.getAttribute("aria-controls")!;
  const panel = document.getElementById(panelId)!;
  expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  expect(panel).toHaveAttribute("role", "tabpanel");
});

test("every panel stays in the DOM; only the active one is exposed", () => {
  render(<Harness />);
  // All three are rendered — remounting would discard panel-local state.
  expect(document.querySelectorAll("[role=tabpanel]")).toHaveLength(3);
  // Only one is visible to the accessibility tree.
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(screen.getByRole("tabpanel")).toHaveTextContent("panel fit");
});

test("clicking a tab activates it and swaps the exposed panel", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("tab", { name: "Export" }));
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("panel export");
});

test("only the active tab is keyboard-reachable (roving tabindex)", () => {
  render(<Harness />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs[0]).toHaveAttribute("tabindex", "0");
  expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  expect(tabs[2]).toHaveAttribute("tabindex", "-1");
});

test("arrow keys move between tabs and wrap around", () => {
  render(<Harness />);
  const strip = screen.getByRole("tablist");
  fireEvent.keyDown(strip, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Reference" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(strip, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
  // wraps backwards from the first to the last
  fireEvent.keyDown(strip, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
});

test("Home and End jump to the first and last tab", () => {
  render(<Harness />);
  const strip = screen.getByRole("tablist");
  fireEvent.keyDown(strip, { key: "End" });
  expect(screen.getByRole("tab", { name: "Export" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(strip, { key: "Home" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
});

test("an unrelated key does not change the active tab", () => {
  render(<Harness />);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "a" });
  expect(screen.getByRole("tab", { name: "Scale & fit" })).toHaveAttribute("aria-selected", "true");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/ui/Tabs.test.tsx`
Expected: FAIL — cannot resolve `./Tabs`.

- [ ] **Step 3: Write the component**

Create `frontend/src/components/ui/Tabs.tsx`:

```tsx
import { type KeyboardEvent } from "react";

export type TabDefinition = {
  id: string;
  label: string;
};

type Props = {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  /** Prefix for the generated id / aria-controls pair. */
  idPrefix: string;
  className?: string;
};

const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
const panelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

/**
 * Props for a panel belonging to a {@link Tabs} strip.
 *
 * Every panel stays mounted and the inactive ones are `hidden`, which keeps
 * them out of the accessibility tree while preserving their local state —
 * these panels hold typed values that a remount would discard.
 */
export function tabPanelProps(idPrefix: string, id: string, active: boolean) {
  return {
    id: panelId(idPrefix, id),
    role: "tabpanel" as const,
    "aria-labelledby": tabId(idPrefix, id),
    hidden: !active
  };
}

/**
 * Tab strip following the ARIA tabs pattern: one tab stop for the whole strip,
 * with arrow keys moving between tabs (roving tabindex).
 */
export function Tabs({ tabs, active, onChange, idPrefix, className = "" }: Props) {
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active)
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = activeIndex === last ? 0 : activeIndex + 1;
    else if (event.key === "ArrowLeft") next = activeIndex === 0 ? last : activeIndex - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
  };

  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={`flex gap-1 border-b border-[var(--color-border)] ${className}`}
    >
      {tabs.map((tab, index) => {
        const selected = index === activeIndex;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              "-mb-px border-b-2 px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
              "focus-visible:ring-[var(--color-primary)]",
              // The underline, not colour alone, carries the selected state.
              selected
                ? "border-[var(--color-primary)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Export it**

Add to `frontend/src/components/ui/index.ts`. That file is one `export { X } from "./X";` per line in alphabetical order, so `Tabs` goes last, after `StatusDot`:

```ts
export { Tabs, tabPanelProps, type TabDefinition } from "./Tabs";
```

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `cd frontend && npx tsc -b && npx vitest run src/components/ui/Tabs.test.tsx`
Expected: exit 0 and 8 passing tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/Tabs.tsx frontend/src/components/ui/Tabs.test.tsx frontend/src/components/ui/index.ts
git commit -m "feat: add an accessible tabs primitive"
```

---

## Task 3: Single floor control, conditional relink, compressed hint

**Files:**
- Modify: `frontend/src/components/illustrator/PlacementMap.tsx:305-319`
- Modify: `frontend/src/components/illustrator/TransformPanel.tsx:102-154`
- Create: `frontend/src/components/illustrator/TransformPanel.test.tsx`

**Interfaces:**
- Consumes: `PlacementState.floors[].linked` (already present).
- Produces: `TransformPanel` no longer renders a floor `<select>`; the relink action survives as a conditional row; the long interaction hint moves behind a `?` popover. `PlacementMap`'s floor pills mark unlinked floors.

The pill marker and the dropbox deletion land in **one commit** deliberately: the
dropdown is the only place the `(unlinked)` state is currently shown, so
splitting them would leave a commit where that information is missing.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/illustrator/TransformPanel.test.tsx`:

```tsx
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { TransformPanel } from "./TransformPanel";
import { DEFAULT_METRES_PER_POINT, type PlacementState } from "../../hooks/useIllustratorPlacement";


function stateWith(floors: { label: string; linked: boolean }[], active: string): PlacementState {
  return {
    frame: { rotationDeg: 0, metresPerPoint: DEFAULT_METRES_PER_POINT, workingCrs: "EPSG:6677" },
    activeFloorLabel: active,
    scaleLocked: false,
    floors: floors.map((floor) => ({
      label: floor.label,
      linked: floor.linked,
      artworkAnchor: [50, 50] as [number, number],
      mapAnchor: [139.7671, 35.6812] as [number, number],
      controlPoints: [],
      artworkBounds: [0, 0, 100, 100] as [number, number, number, number]
    }))
  };
}

const THREE_LINKED = stateWith(
  [
    { label: "1F", linked: true },
    { label: "2F", linked: true },
    { label: "3F", linked: true }
  ],
  "1F"
);


test("no floor dropdown is rendered, even with three floors", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // Floor switching lives on the map pills; a second control would be redundant.
  // Asserted on the element, not a label query: the current label is not
  // associated with the select, so a label query would pass either way.
  expect(document.querySelector("select")).toBeNull();
});

test("the relink action appears only when the active floor is unlinked", () => {
  const { rerender } = render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  expect(screen.queryByRole("button", { name: /relink/i })).toBeNull();

  const unlinked = stateWith(
    [
      { label: "1F", linked: false },
      { label: "2F", linked: true }
    ],
    "1F"
  );
  rerender(<TransformPanel state={unlinked} dispatch={() => {}} />);
  expect(screen.getByRole("button", { name: /relink/i })).toBeInTheDocument();
});

test("relinking dispatches relinkFloor for the active floor", () => {
  const seen: { type: string; label?: string }[] = [];
  const unlinked = stateWith([{ label: "2F", linked: false }], "2F");
  render(
    <TransformPanel
      state={unlinked}
      dispatch={(action) => seen.push(action as { type: string; label?: string })}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /relink/i }));
  expect(seen).toEqual([{ type: "relinkFloor", label: "2F" }]);
});

test("the interaction hint is one line, with the detail behind a control", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // The short form is always visible.
  expect(screen.getByText(/corners scale/i)).toBeInTheDocument();
  // The keyboard detail is not taking permanent space...
  expect(screen.queryByText(/arrows nudge/i)).toBeNull();
  // ...but is reachable.
  fireEvent.click(screen.getByRole("button", { name: /keyboard and mouse help/i }));
  expect(screen.getByText(/arrows nudge/i)).toBeInTheDocument();
});

test("the scale controls are no longer in this panel", () => {
  render(<TransformPanel state={THREE_LINKED} dispatch={() => {}} />);
  // Scale moved to the Scale & fit tab panel.
  expect(screen.queryByText(/m per point/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Calibrate" })).toBeNull();
});
```

Note the last test asserts the Task 4 outcome. It fails until Task 4 removes the
Scale section. Mark it skipped with `test.skip` in this task and un-skip it in
Task 4 Step 4 — do not delete it, and do not implement Task 4 early to satisfy it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/illustrator/TransformPanel.test.tsx`
Expected: FAIL — a `select` is found, no relink button when linked, and no help control exists.

- [ ] **Step 3: Mark unlinked floors on the map pills**

In `frontend/src/components/illustrator/PlacementMap.tsx`, replace the floor-pill block at lines 306-319:

```tsx
        {floors.length > 1 ? (
          <div className="flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-white/90 p-1 shadow">
            {floors.map((floor) => {
              const linked = state.floors.find((f) => f.label === floor.label)?.linked ?? true;
              return (
                <Button
                  key={floor.label}
                  size="sm"
                  variant={floor.label === state.activeFloorLabel ? "primary" : "secondary"}
                  onClick={() => dispatch({ type: "setActiveFloor", label: floor.label })}
                  title={
                    linked
                      ? floor.label
                      : `${floor.label} ${t("(unlinked)", "（非連動）")}`
                  }
                >
                  {/* A dot, not colour alone, so the state survives a
                      colour-vision deficiency. */}
                  {linked ? null : (
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-1 w-1 rounded-full bg-current"
                    />
                  )}
                  {floor.label}
                </Button>
              );
            })}
          </div>
        ) : null}
```

`t` is already in scope in this component (it renders `basemapLabel(id, t)` at line 328). If it is not destructured from `useUiLanguage()` there, add it.

- [ ] **Step 4: Replace the pinned-block head of TransformPanel**

In `frontend/src/components/illustrator/TransformPanel.tsx`, replace lines 102-154 — the Undo/Redo section, the hint paragraph, and the whole floor `<section>`:

```tsx
      <section className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canUndo}
          onClick={() => dispatch({ type: "undo" })}
        >
          <Undo2 size={13} className="mr-1" />
          {t("Undo", "元に戻す")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canRedo}
          onClick={() => dispatch({ type: "redo" })}
        >
          <Redo2 size={13} className="mr-1" />
          {t("Redo", "やり直す")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t("Keyboard and mouse help", "キーボードとマウスの操作")}
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </Button>
      </section>
      <p className="-mt-2 text-xs text-[var(--color-text-muted)]">
        {t(
          "Drag a floor to move it. Corners scale, top handle rotates.",
          "ドラッグでフロアを移動。四隅で拡大縮小、上のハンドルで回転。"
        )}
      </p>
      {helpOpen ? (
        <p className="-mt-2 rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] p-2 text-xs text-[var(--color-text-secondary)]">
          {t(
            "Alt+drag moves the whole building. Ctrl+Z / Ctrl+Shift+Z undo and redo. Arrow keys nudge 1 m, Shift+arrows 10 m. Hold Shift while rotating to snap to 15°.",
            "Alt＋ドラッグで建物全体を移動。Ctrl+Z / Ctrl+Shift+Z で元に戻す・やり直す。矢印キーで1m、Shift＋矢印で10m移動。回転中に Shift で15度刻み。"
          )}
        </p>
      ) : null}
      {activeFloor && !activeFloor.linked ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => dispatch({ type: "relinkFloor", label: activeFloor.label })}
        >
          {t("Relink to shared frame", "共通フレームに再リンク")}
        </Button>
      ) : null}
```

Add the help state beside the other `useState` calls (after line 43):

```tsx
  const [helpOpen, setHelpOpen] = useState(false);
```

The Shift-to-snap line at `TransformPanel.tsx:243-245` is now covered by the help
text, so delete that paragraph from the rotation section to reclaim its height.

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: exit 0; the four un-skipped new tests pass; the pre-existing 118 still pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/illustrator/PlacementMap.tsx frontend/src/components/illustrator/TransformPanel.tsx frontend/src/components/illustrator/TransformPanel.test.tsx
git commit -m "feat: single floor control on the map, relink and help kept in the panel"
```

---

## Task 4: Extract the Scale & fit panel

**Files:**
- Create: `frontend/src/components/illustrator/ScaleAndFitPanel.tsx`
- Modify: `frontend/src/components/illustrator/TransformPanel.tsx` (delete the Scale section and its now-unused state)
- Modify: `frontend/src/components/illustrator/TransformPanel.test.tsx` (un-skip one test)

**Interfaces:**
- Produces:
  ```tsx
  export function ScaleAndFitPanel(props: {
    state: PlacementState;
    dispatch: (action: PlacementAction) => void;
    picking: boolean;
    onTogglePicking: () => void;
  }): JSX.Element;
  ```
  It owns the drawing-scale and calibrate form state that used to live in
  `TransformPanel`, and renders `ControlPointList` beneath it.

- [ ] **Step 1: Create the panel**

Create `frontend/src/components/illustrator/ScaleAndFitPanel.tsx`. The scale
markup is moved verbatim from `TransformPanel.tsx:248-314`; only the wrapper and
the state ownership change:

```tsx
import { useState } from "react";

import { useUiLanguage } from "../../hooks/useUiLanguage";
import {
  DEFAULT_DRAWING_SCALE,
  resolvedTransform,
  type PlacementAction,
  type PlacementState
} from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";
import { ControlPointList } from "./ControlPointList";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  picking: boolean;
  onTogglePicking: () => void;
};

/**
 * Everything that derives the transform numerically: the drawing scale, the
 * measured-distance calibration, and the control points that fit both at once.
 */
export function ScaleAndFitPanel({ state, dispatch, picking, onTogglePicking }: Props) {
  const { t } = useUiLanguage();
  const [denominator, setDenominator] = useState(String(DEFAULT_DRAWING_SCALE));
  const [artworkDistance, setArtworkDistance] = useState("");
  const [realMetres, setRealMetres] = useState("");

  const activeFloor =
    state.floors.find((f) => f.label === state.activeFloorLabel) ?? state.floors[0];
  const activeTransform = activeFloor ? resolvedTransform(state, activeFloor) : null;

  return (
    <div className="space-y-4 text-sm">
      <section>
        <label className="block text-xs font-medium">
          {t("Scale", "縮尺")}{" "}
          {state.scaleLocked ? (
            <span className="text-[var(--color-success)]">{t("(locked)", "（固定）")}</span>
          ) : null}
        </label>
        <p className="mt-1 text-xs">
          {(activeTransform?.metresPerPoint ?? state.frame.metresPerPoint).toFixed(6)}{" "}
          {t("m per point", "m/pt")}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs">1:</span>
          <input
            type="number"
            className="w-24 rounded-[var(--radius-md)] border px-2 py-1"
            value={denominator}
            onChange={(event) => setDenominator(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => dispatch({ type: "setDrawingScale", denominator: Number(denominator) })}
          >
            {t("Apply", "適用")}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="pt"
            value={artworkDistance}
            onChange={(event) => setArtworkDistance(event.target.value)}
          />
          <span className="text-xs">=</span>
          <input
            type="number"
            className="w-20 rounded-[var(--radius-md)] border px-2 py-1"
            placeholder="m"
            value={realMetres}
            onChange={(event) => setRealMetres(event.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              dispatch({
                type: "calibrateDistance",
                artworkDistance: Number(artworkDistance),
                realMetres: Number(realMetres)
              })
            }
          >
            {t("Calibrate", "校正")}
          </Button>
        </div>
        {state.scaleLocked ? (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => dispatch({ type: "unlockScale" })}
          >
            {t("Unlock scale", "縮尺の固定を解除")}
          </Button>
        ) : null}
      </section>

      <ControlPointList
        state={state}
        dispatch={dispatch}
        picking={picking}
        onTogglePicking={onTogglePicking}
      />
    </div>
  );
}
```

- [ ] **Step 2: Remove the Scale section from TransformPanel**

Delete the entire `<section>` at `TransformPanel.tsx:248-314` (the Scale block).
Then delete the three now-unused `useState` declarations at lines 41-43
(`denominator`, `artworkDistance`, `realMetres`) and the `DEFAULT_DRAWING_SCALE`
import. `noUnusedLocals` will fail the build if any is left behind, which is the
check that nothing was missed.

Confirm `resolvedTransform` and `activeTransform` are still used by the rotation
section (`TransformPanel.tsx:219`, `:210`) — they are, so both stay.

- [ ] **Step 3: Un-skip the scale test**

In `frontend/src/components/illustrator/TransformPanel.test.tsx`, change
`test.skip("the scale controls are no longer in this panel"` back to `test(`.

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: exit 0; all five `TransformPanel` tests pass; 118 pre-existing still pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/illustrator/ScaleAndFitPanel.tsx frontend/src/components/illustrator/TransformPanel.tsx frontend/src/components/illustrator/TransformPanel.test.tsx
git commit -m "refactor: move scale and control points into a Scale & fit panel"
```

---

## Task 5: Assemble the tabbed sidebar

**Files:**
- Create: `frontend/src/components/illustrator/ExportPanel.tsx`
- Modify: `frontend/src/pages/IllustratorPage.tsx:347-408`

**Interfaces:**
- Consumes: `Tabs` / `tabPanelProps` (Task 2), `ScaleAndFitPanel` (Task 4).
- Produces:
  ```tsx
  export function ExportPanel(props: {
    state: PlacementState;
    dispatch: (action: PlacementAction) => void;
    artworkBounds: [number, number, number, number];
    crsChoices: { value: string; label: string }[];
    outputCrs: string;
    onOutputCrsChange: (value: string) => void;
    formats: ExportFormatsPayload;
    onFormatsChange: (formats: ExportFormatsPayload) => void;
    onExport: () => void;
    previewFeatures: number;
    totalFeatures: number;
    error: string | null;
  }): JSX.Element;
  ```

- [ ] **Step 1: Create the export panel**

Create `frontend/src/components/illustrator/ExportPanel.tsx`. The markup is moved
verbatim from `IllustratorPage.tsx:374-407`, with `PlacementLibrary` above it:

```tsx
import { useUiLanguage } from "../../hooks/useUiLanguage";
import type { ExportFormatsPayload } from "../../api/client";
import type { PlacementAction, PlacementState } from "../../hooks/useIllustratorPlacement";
import { Button } from "../ui";
import { PlacementLibrary } from "./PlacementLibrary";

type Props = {
  state: PlacementState;
  dispatch: (action: PlacementAction) => void;
  artworkBounds: [number, number, number, number];
  crsChoices: { value: string; label: string }[];
  outputCrs: string;
  onOutputCrsChange: (value: string) => void;
  formats: ExportFormatsPayload;
  onFormatsChange: (formats: ExportFormatsPayload) => void;
  onExport: () => void;
  previewFeatures: number;
  totalFeatures: number;
  error: string | null;
};

/** Saving a placement for reuse, and emitting the georeferenced files. */
export function ExportPanel({
  state,
  dispatch,
  artworkBounds,
  crsChoices,
  outputCrs,
  onOutputCrsChange,
  formats,
  onFormatsChange,
  onExport,
  previewFeatures,
  totalFeatures,
  error
}: Props) {
  const { t } = useUiLanguage();

  return (
    <div className="space-y-4 text-sm">
      <PlacementLibrary state={state} dispatch={dispatch} artworkBounds={artworkBounds} />

      <section>
        <span className="text-xs font-medium">{t("Export", "書き出し")}</span>
        <select
          className="mt-1 w-full rounded-[var(--radius-md)] border px-2 py-1 text-sm"
          value={outputCrs}
          onChange={(event) => onOutputCrsChange(event.target.value)}
        >
          {crsChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {(["geopackage", "shapefile", "qgis"] as const).map((key) => (
          <label key={key} className="mt-1 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={formats[key]}
              onChange={(event) => onFormatsChange({ ...formats, [key]: event.target.checked })}
            />
            {key}
          </label>
        ))}
        <Button className="mt-2 w-full" onClick={onExport}>
          {t("Export", "書き出し")}
        </Button>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          {t(
            `Preview shows ${previewFeatures} of ${totalFeatures} shapes.`,
            `プレビューは ${totalFeatures} 図形中 ${previewFeatures} 件を表示。`
          )}
        </p>
        {error ? <p className="mt-2 text-xs text-[var(--color-error)]">{error}</p> : null}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Add the tab state to IllustratorPage**

Beside the other `useState` calls in `IllustratorPage` (near line 150), add:

```tsx
  const [placementTab, setPlacementTab] = useState("fit");
```

- [ ] **Step 3: Replace the sidebar**

In `frontend/src/pages/IllustratorPage.tsx`, replace the sidebar column — lines
349-408, i.e. everything from the `w-80` div through its closing `</div>`:

```tsx
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-hidden">
        <Card padding="md" className="shrink-0">
          <TransformPanel
            state={state}
            dispatch={dispatch}
            siteName={siteName}
            onLocate={setRecenterTo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
          />
        </Card>

        {/* One card holds the strip and the panels — a card inside a card is
            never right. The panel area takes the remaining height and is the
            only scrolling region in this column, so no amount of content can
            push the page again. */}
        <Card padding="md" className="flex min-h-0 flex-1 flex-col">
          <Tabs
            tabs={[
              { id: "fit", label: t("Scale & fit", "縮尺と調整") },
              { id: "reference", label: t("Reference", "参照") },
              { id: "export", label: t("Export", "書き出し") }
            ]}
            active={placementTab}
            onChange={setPlacementTab}
            idPrefix="placement"
            className="shrink-0"
          />
          <div className="min-h-0 flex-1 overflow-auto pt-3">
            <div {...tabPanelProps("placement", "fit", placementTab === "fit")}>
              <ScaleAndFitPanel
                state={state}
                dispatch={dispatch}
                picking={picking}
                onTogglePicking={() => setPicking((value) => !value)}
              />
            </div>
            <div {...tabPanelProps("placement", "reference", placementTab === "reference")}>
              <ReferenceLayerList layers={referenceLayers} onChange={setReferenceLayers} />
            </div>
            <div {...tabPanelProps("placement", "export", placementTab === "export")}>
              <ExportPanel
                state={state}
                dispatch={dispatch}
                artworkBounds={bounds}
                crsChoices={CRS_CHOICES(preview.suggested_crs, preview.suggested_crs_label)}
                outputCrs={outputCrs}
                onOutputCrsChange={setOutputCrs}
                formats={formats}
                onFormatsChange={setFormats}
                onExport={() => void download()}
                previewFeatures={preview.preview_features}
                totalFeatures={preview.total_features}
                error={error}
              />
            </div>
          </div>
        </Card>
      </div>
```

Update the imports: add `Tabs` and `tabPanelProps` from `../components/ui`, add
`ScaleAndFitPanel` and `ExportPanel`, and remove `ControlPointList` and
`PlacementLibrary` — both are now rendered by the new panels, and
`noUnusedLocals` will fail the build if their imports are left.

- [ ] **Step 4: Verify**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: exit 0 and every test passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/illustrator/ExportPanel.tsx frontend/src/pages/IllustratorPage.tsx
git commit -m "feat: tabbed placement sidebar that fits the viewport"
```

---

## Task 6: Measured verification

**Files:** none modified. This task is proof the goal is met.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: measurements at four viewport heights, plus browser observations.

The acceptance criterion is the same measurement the problem statement was built
from, so it is re-measured the same way.

- [ ] **Step 1: Run the suites**

Run: `cd frontend && npx tsc -b && npx vitest run`, then `python -m pytest -q` from the repo root.
Expected: `tsc` exit 0; all frontend tests pass; backend unchanged at 311 passed.

- [ ] **Step 2: Build a three-floor fixture**

A multi-page `.ai` produces one floor per page, which is what puts the floor
pills on the map. Generate a three-page PDF the same way
`backend/tests/test_illustrator_import.py::_build_multipage_ai_pdf` does, write
it to `data/tmp/`, and delete it when finished.

- [ ] **Step 3: Measure, at 720, 800, 900 and 1080 viewport heights**

Load the fixture, assign floors, reach the placement view, then for each height assert:

```js
const de = document.documentElement;
const col = document.querySelector('div.w-80');
const panel = col.querySelector('[role=tabpanel]').parentElement;
const map = document.querySelector('.maplibregl-map');
const exportBtn = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === 'Export').pop();
return {
  documentScrollsBy: de.scrollHeight - de.clientHeight,      // must be 0
  columnScrollsBy: col.scrollHeight - col.clientHeight,      // must be 0
  panelScrollsBy: panel.scrollHeight - panel.clientHeight,   // 0 in the normal case
  mapHeight: Math.round(map.getBoundingClientRect().height), // ≈ innerHeight - 80
  exportVisible: (() => { const r = exportBtn.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()
};
```

Expected at every height: `documentScrollsBy === 0`, `columnScrollsBy === 0`,
`mapHeight` within a few pixels of `innerHeight - 80`, and — on the Export tab —
`exportVisible === true`. Compare against the "before" table in the spec.

- [ ] **Step 4: Check the behaviours the numbers cannot show**

1. Switching tabs keeps all of Step 3 true.
2. Type `1:500` into the drawing scale, switch to Reference, switch back — the
   field still reads `500`. This is the state-preservation the `hidden` approach
   exists for; if it resets, panels are unmounting.
3. Type a name into Saved placements, switch tabs and back — still there. The
   network tab shows `listPlacements` called once, not once per visit.
4. With three floors, the map pills are the only floor control, and dragging one
   floor away shows the dot on its pill.
5. Tab through the strip with the keyboard: one tab stop, arrows move, the focus
   ring is visible.
6. Add several control points and confirm the Scale & fit panel scrolls
   internally while `documentScrollsBy` stays 0.
7. Confirm the three English tab labels fit the 320px column without wrapping,
   and check the Japanese labels too via the language toggle.

- [ ] **Step 5: Report**

No commit. Report the measurement table, the seven observations, and any
deviation. If a tab label wraps, shorten `Scale & fit` to `Fit` and re-measure.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Bound the shell; content wrapper scrolls rather than clips | 1 |
| Placement view bounded; map fills viewport height | 1 |
| Accessible tab primitive (roles, roving tabindex, arrows, Home/End, focus ring) | 2 |
| Panels stay mounted behind `hidden` | 2 (`tabPanelProps`), 5 (usage) |
| Floor `<select>` deleted | 3 |
| Relink kept, conditional, 0px when linked | 3 |
| Unlinked marker on the pills — dot plus `title`, not colour alone | 3 |
| Hint compressed to one line, detail behind `?` | 3 |
| Scale moves to the Scale & fit panel with control points | 4 |
| Reference panel = reference layers, not labelled "Layers" | 5 |
| Export panel = saved placements + CRS + formats + button + count | 5 |
| Tab state local to `IllustratorPage`, default Scale & fit | 5 |
| Panel is the only scrolling region | 5 |
| Measured acceptance at 720/800/900/1080 | 6 |
| No new colours, no nested cards | 2, 5 |

Non-goals held: no transform maths, export output, or backend file is touched; the map overlays change only by the one pill marker; the upload and assign views keep their centred-card layout.

**Type consistency:** `TabDefinition` and `tabPanelProps(idPrefix, id, active)` are defined in Task 2 and used with that exact signature in Task 5. `ScaleAndFitPanel`'s four props match `ControlPointList`'s existing `picking` / `onTogglePicking` pair. `ExportPanel` takes `ExportFormatsPayload` — the same type `IllustratorPage` already holds in `formats`.

**Known sequencing:** Task 3's fifth test asserts a Task 4 outcome and is written `test.skip` in Task 3, un-skipped in Task 4 Step 3. This is deliberate — the assertion belongs with the other `TransformPanel` tests rather than in a separate file — and both tasks name it, so it cannot be silently lost. Every task leaves a shippable app: Task 1 gives the column `overflow-auto` so it scrolls internally and the Export button stays reachable, and Task 5 tightens that to `overflow-hidden` only once the tab panel owns the single scroll region.
