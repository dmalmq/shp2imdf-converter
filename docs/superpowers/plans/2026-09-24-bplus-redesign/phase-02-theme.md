# Theme tokens and type

Back to [overview](overview.md).

**Goal.** B+'s palette and type as the app's tokens, light and dark, with contrast proven.

**Changes.**
- `frontend/src/index.css`: paper, card, ink, muted and line surfaces; pine as primary; rust as
  destructive; warning stays as shipped in #69 (`warning` #CA8A04, `warning-foreground`
  #854D0E, which matches B's ochre text) with B's tint #F3E6C4 for warning surfaces; sky as info and
  reference; plum as the artwork colour. Dark values from Figma frame 122:2.
- `frontend/tailwind.config.ts`: `info`, `artwork` (renaming `signal`, migrating every
  `signal` class in the same PR), a display font family.
- Fonts: add Fraunces via @fontsource; keep IBM Plex Sans JP and Geist Mono.
- `ARTWORK_TINT` and the test mocks that hard-code it move to plum.

**Data structures.** Token names only: paper, card, ink, muted, line, primary (pine),
destructive (rust), warning and warning-foreground (unchanged from #69), warning-surface
(B's tint), info (sky), artwork (plum).

**Verification.** Gates; a contrast table computed from the rendered app (not the design)
for body, muted and each state colour on its surfaces, all at least 4.5:1; before/after captures.
