# App shell and top bar

Back to [overview](overview.md).

**Goal.** One B+ top bar on every route, with the stage track under it.

**Changes.**
- `components/shell/AppShell.tsx`: A's mark and `shp2imdf`, breadcrumb (Projects / station /
  stage), a search field slot (inert until phase 12), save status, EN/日本語, theme, and a
  primary action slot pages fill. Remove ReviewPage's own header and its duplicate toggles.
- `StepIndicator` and `IllustratorSteps` become one stage track component fed by a stage model.

**Data structures.** `Stage = { id, label: {en, ja}, status: "done" | "current" | "todo" |
"blocked", detail? }`; `Flow = "shapefiles" | "artwork"` with its ordered stages.

**Verification.** Gates; captures show one header on every route and no duplicate toggles;
every top-bar control reachable by keyboard.
