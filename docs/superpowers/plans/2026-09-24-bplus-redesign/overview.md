# B+ redesign: overview

## Context

Daniel explored three fresh concepts in Figma (file `SmPsQWy9LDveQ0fJWJciID`) and chose
**Concept B+**: Concept B's project hub and four-stage pipeline, with Concept A's top bar,
logo and command search. Pages: `Concept B+ · Hub + A's top bar & search` (110:2, light and
dark) and `Concept B+ · Illustrator artwork flow` (112:2). Decisions already made:
the artwork is plum, there are no logins (sessions, not people), dark mode is included,
and control-point residuals appear after two pairs when scale is locked.

The app today is a three-step tool (Import, Configure, Review & Export) plus a separate
Illustrator route. It forgets everything on reload, keeps sessions for 24 hours and
conversions for 2 hours, and has no list of past work. B+ is organised around station
projects people come back to, so the redesign is partly visual and partly structural.

## Scope

Included:
- B+ theme (light and dark), type (Fraunces, IBM Plex Sans JP, Geist Mono) and the plum
  artwork colour.
- One app shell: A's mark and `shp2imdf` wordmark, breadcrumb, search field, save status,
  EN/日本語, a stage-following primary action, and the stage track under it.
- Project-addressed routes, so a project survives reload and can be resumed.
- A project hub backed by a cheap project listing API.
- The four shapefile stages (Bring in, Set up, Check, Deliver) and the four artwork stages
  (Bring in artwork, Name floors, Place on map, Deliver) in B+'s layout.
- Search and commands (Ctrl K) with grouped results and plain-sentence previews.
- Session handover: last session, an automatic change log, and an optional note.
- Control-point residuals after two pairs when scale is locked.

Excluded:
- Logins, user identity or per-person attribution.
- Changes to IMDF generation, validation rules or export formats.
- Resume-a-saved-placement on the upload screen (needs placement/conversion linkage; a
  separate project).
- Mobile layouts.

## Constraints

- Ports stay 5310 / 8310; the shared-PC deployment model is unchanged.
- The placement maths is guarded by the cross-language golden fixture
  (`test_illustrator_georeference.py`, `similarity.test.ts`). Any change to it runs both.
- `frontend/tsconfig.json` is `files: []`: the type gate is
  `npx tsc --noEmit -p tsconfig.app.json` and `-p tsconfig.node.json`, never `-p .`.
- Session listing must stay cheap: `test_filesystem_create_does_not_reparse_every_session`
  forbids parsing every session file on create. Read `.meta.json`, never `list_all()`.
- Every UI string stays bilingual through `t("en", "ja")`; Japanese copy proposed in Figma
  is unreviewed and gets a native read before release.
- The whole frontend is already on shadcn (no legacy kit), so the reskin is token-first.

## Alternatives

1. **Incremental, route by route on main** (chosen). Tokens and shell land first, then each
   stage is rebuilt behind the same routes, each PR shippable. The app stays usable on the
   shared PC throughout, and every PR is verified against the previous screens.
2. **Big-bang rewrite on a long-lived branch.** Rejected: weeks of drift against main, and
   no verifiable intermediate state.
3. **A parallel `/v2` app.** Rejected: doubles maintenance and splits sessions between two
   UIs on a shared machine.

## Applicable skills

`how` before each unfamiliar subsystem; `architect` for the one-way doors (project routes,
the project listing model, the command grammar); `interrogate` before shipping the
contested ones; `unslop` over every diff and PR body; `tdd` for the backend listing and the
autosave-adjacent state; `show-me-your-work` for the decision trail in `decisions.md`.
Verification uses the repo's own driver, `.cursor/skills/verify-shp2imdf/scripts/control.mjs`.

## Phases

1. [Harness and baseline](phase-01-harness.md)
2. [Theme tokens and type](phase-02-theme.md)
3. [Two-pair residuals when scale is locked](phase-03-two-pair-residuals.md)
4. [App shell and top bar](phase-04-shell.md)
5. [Project-addressed routes](phase-05-project-routes.md)
6. [Project listing API and lifetimes](phase-06-project-api.md)
7. [Hub](phase-07-hub.md)
8. [Bring in](phase-08-bring-in.md)
9. [Set up](phase-09-set-up.md)
10. [Check](phase-10-check.md)
11. [Deliver](phase-11-deliver.md)
12. [Search and commands](phase-12-search.md)
13. [Handover](phase-13-handover.md)
14. [Illustrator route in B+](phase-14-illustrator.md)
15. [Japanese copy and dark pass](phase-15-polish.md)

Phases 1, 2 and 3 have no dependency on each other and run in parallel. Phase 4 needs 2.
Phases 5 and 6 are the structural core; 7 needs both. 8–11 need 4 and 5. 12 needs 4 and the
stage pages it searches. 13 needs 6. 14 needs 4, 5 and 3. 15 is last.

## Verification

See [testing.md](testing.md). Every phase: `pytest`, `npx tsc --noEmit -p tsconfig.app.json`,
`-p tsconfig.node.json`, `npx vitest run`, and a live run through `control.mjs` with
before/after screenshots in light and dark, EN and 日本語, for the screens the phase touches.
Each PR gets an independent three-lane verdict (gates, live, diff audit) before merge.

## Implementation guidance

Apply `how` before changing each subsystem, `unslop` before every commit, `interrogate` on
phases 5, 6 and 12, and keep `decisions.md` current. Babysit only on request.
