# Design: project identity, listing and lifetimes (phases 5 and 6)

Back to [overview](overview.md). Status: revised 2026-09-24 after an independent adversarial review (verdict: sound with
changes; every must-change below is folded in). Lifetime defaults still pending Daniel.

## Findings that change the plan

- **F1. Switching projects in the store only clears drafts.** `setSessionId` resets only
  `wizardDrafts` (`frontend/src/store/useAppStore.ts:173-174`); files, wizardState, geojsonData,
  selection, editHistory and filters survive a switch. URL hydration needs a
  `switchProject(id)` that resets all per-session state.
- **F2. Stored sessions reject unknown fields.** `SessionRecord` and its nested models are
  `extra="forbid"` (`backend/src/schemas.py:219,309-310`), and `_read` does not catch
  `ValidationError` (`session.py:134`), so after a rollback every session saved since returns 500.
  Many of these models double as request bodies (`ProjectWizardState`, `wizard_router.py:540`),
  so they must stay strict for input. Fix: strip unknown keys in the storage layer before
  `model_validate`, add `schema_version`, and map an unreadable record to not-found.
- **F3. Conversion ids are unvalidated, and this is a live security bug.** `ConversionStore.get`
  joins the raw id onto the root (`backend/src/illustrator_store.py:97`). The route excludes "/",
  but uvicorn percent-decodes the path, so `%5C` arrives as a backslash, a Windows path
  separator: `%5C%5Chost%5Cshare` becomes a UNC path and the `is_file()` check opens an SMB
  connection (NTLM hash leak); `C:%5C...` reaches any absolute path. The rmtree on expiry needs a
  parseable `conversion.json`, so data loss is unlikely. Fix: validate against the generated
  format before any Path construction, and assert `directory.resolve().parent == root.resolve()`.
- **F4. The index is rebuilt from the full record.** `get()` and `touch()` rebuild the index
  entry via `SessionSummary.of(session)` (`session.py:181,187`), so every summary field must be
  derivable from `SessionRecord` or the next `get` erases it. Also
  `FileSystemSessionBackend.list_summaries` copies only three fields (`session.py:206`) and must
  copy the new ones.
- **F5. An artwork conversion cannot be reopened.** The only way to a preview is
  `POST /convert/illustrator/preview`, which re-parses an upload (`import_router.py:336`);
  `floors.json` is written (`illustrator_store.py:124-130`) but never returned.
- **F6. `last_accessed` is not a content timestamp.** `get_session` writes it on the cached
  record (`session.py:259`), `get()` copies the index touch into the record (`:179-180`), and
  every save and export bumps it. Anything derived from it ("changed since delivery",
  "updated") would be wrong. Fix: a `content_rev` integer that only mutating handlers bump.
- **F7. `validation` is never cleared.** Wizard edits reset `generation_status`
  (`wizard_router.py:548..782`) but leave `validation`; feature edits (`features_router.py:377-618`)
  do not revalidate. A stale clean validation would read as "deliver". Fix: store
  `validation_rev`, treat validation as absent when `validation_rev != content_rev`, and clear it
  wherever `generation_status` is reset.
- **F8. The project type is client-only.** `importProfile` lives in the store
  (`useAppStore.ts:134`) and decides the export default (`ReviewPage.tsx:935,1272`); a reload
  falls back to `standard`. The summary carries `import_profile` and `switchProject` restores it.
- **F9. Artwork auto-locates on mount.** `LocateControl` geocodes the file name and dispatches
  `positionBuilding` (`LocateControl.tsx:47-66`), which sets `stationPin` and resets history
  (`useIllustratorPlacement.ts:250,703`). "Linked with a pin" therefore cannot mean placed, and a
  restored placement would be overwritten on reload unless the lookup is skipped when one exists.

## 1. Identity and URLs

Options: (A) kind in the path, `/shapefiles/:sessionId/{bring-in,set-up,check,deliver}` and
`/artwork/:conversionId/{bring-in,name-floors,place,deliver}`; (B) `/projects/:id/:stage` with a
kind lookup; (C) query params on today's routes. **Recommended: A** (no lookup, stage slugs
validated per flow, readable permanent URLs; `/p` and `/a` acceptable if brevity wins).

Decision: keep the plan's `/p/:id/<stage>` and `/a/:id/<stage>` (phase 5 already fixed them;
not reopened).

Hydration: a `ProjectLayout` route element reads `:id` and renders `<Outlet key={id}>`, so the
old project's tree unmounts (and its autosave flushes against the old id) before
`switchProject(id)` resets all per-session state (F1). Late responses whose id is not the
store's id are ignored. A single-project endpoint `GET /api/projects/{flow}/{id}` feeds the
stage resolver. Pages keep reading `sessionId` from the store (the
store caches the URL). Wizard section stays out of the path (`?section=` hint only).
`/shapefiles/:id` with no stage, or an unreachable stage, redirects (replace) to the project's
stage.

Old routes: `/wizard` and `/review` redirect to `/shapefiles/{store.sessionId}/set-up` and
`/check` when an id is in memory, otherwise `/`; `/illustrator` redirects to `/artwork/new`.
No grace period (one shared PC): just redirect. Hard-coded `navigate("/review")`
(`WizardPage.tsx:693`, `UploadPage.tsx:400,463`) and `capture.mjs`/`control.mjs` move in the
same PR. New work starts at
`/shapefiles/new` and `/artwork/new`; the upload creates the id and navigates with replace.

Expired ids: `SESSION_NOT_FOUND` / `CONVERSION_EXPIRED` open `SessionExpiredDialog`, reworded
"no longer kept (idle more than N days)" with "Back to projects". Wording: "no longer kept" (the cap also removes projects, not only
idleness).

Illustrator state lost on reload today (all client-side, `IllustratorPage.tsx:285-372`):
preview (F5) → new `GET /api/convert/illustrator/{id}` returning preview + floors + placement;
assignment → returned by that GET; placement history `present` (frame, anchors,
controlPoints, linked/pinned, per-floor rotation/scale, artworkMatch, activeFloorLabel,
scaleLocked, stationPin; `useIllustratorPlacement.ts:41-64`) → stored server-side as
`placement.json`; outputCrs and formats → saved with the placement; undo past/future → lost,
accepted; `lastFile` → lost, accepted; uploaded reference overlays → lost with a notice
(preloaded ones re-query from stationPin); transient UI state → lost.

Placement API (moved to phase 14; phases 5-6 only need reload into `place` with preview and
assignment restored): `GET` / `PUT /api/convert/illustrator/{id}/placement`, body
`{revision, state, output_crs, formats}`, optimistic `base_revision` with 409 on stale, atomic
write, floor labels must equal `floors.json`, `assign` deletes `placement.json`, debounced
autosave from `history.present`. On 409, stop autosaving and show "changed in another tab,
reload"; never retry-overwrite. Skip the file-name lookup when a stored placement exists (F9). Export still sends explicit floors, so the placement maths and
golden fixture are untouched. Do not extend `SessionLockMiddleware` to `/api/convert` (long
shape/region matches would block autosave). Named placements in `placements.db` remain
cross-project templates.

## 2. Listing

```
ProjectSummary = { id, flow: "shapefiles"|"artwork", name, import_profile,
  stage, updated_at, last_opened, blockers: int|null, can_wait: int|null,
  delivered_at: str|null, changed_since_delivery: bool, expires_at }
```

Shapefiles: a pure `derive_session_project(record)` in `backend/src/projects.py`, called from
`SessionSummary.of` (F4), O(1), no file reads. New record fields: `content_rev` (F6),
`validation_rev` (F7), `delivered: {at, rev, format, blockers} | None`, `schema_version` (F2).
name = project_name, else venue_name, else the venue feature's name from the in-memory feature
collection (IMDF-archive imports have no wizard project), else the common file-stem prefix.
blockers/can_wait = validation counts when `validation_rev == content_rev`, else null.
updated_at = when `content_rev` last changed; last_opened = index `last_accessed`;
changed_since_delivery = `content_rev > delivered.rev`; expires_at = last_opened + TTL;
`import_profile` included (F8).

Every export marks delivery: `GET /export`, `POST /export/shapefiles`, `POST /export/qgis` and the
artwork export (the ODC delivery is the shapefile export). Export does not block on validation
errors, so `delivered.blockers` records the count at the time.

Stage (first match wins): delivered and not changed since → deliver; `generation_status ==
not_started` → set-up if `wizard.project` is set, else bring-in; current validation with 0
errors → deliver; else check. (There is no "levels confirmed" signal: levels are seeded
automatically, `wizard.py:51-68`.)

Artwork: a `project.json` sidecar rewritten on assign, rename and export (and placement save in
phase 14): `{name (default stem), updated_at, delivered_at, floors_total, floors_placed}`.
placed = pinned, or at least `minControlPoints` control points, or an explicit "placement done"
(F9: a station pin alone is automatic and proves nothing). A short per-id lock inside
`ConversionStore` serialises sidecar writes (no middleware lock: long shape matches must not
block). The store moves out of `TEMP_DATA_DIR` to a durable data directory, since it now holds
projects. Stage: delivered → deliver; floors.json and
all placed → deliver; floors.json → place (blockers = total − placed); else name-floors. Add
`PATCH …/{id}` `{name}`.

Meta v2: `_write_meta` (`session.py:145-151`) writes `meta_version: 2` plus derived fields;
`_load_index` (`:111-117`) reads them with defaults, no record parse (no-reparse invariant holds).
`ConversionStore.list_summaries()` reads conversion.json, project.json and last_used mtime, never
`get()` (which touches/discards), tolerates entries vanishing mid-read.

`GET /api/projects?flow=&limit=100` (max 500) → `{projects, total, limits}`, sorted by
last_opened desc then id, read-only (no touch, no prune), outside the session lock path,
snapshotting the index under the backend lock.

## 3. Lifetimes (defaults pending Daniel)

`PROJECT_IDLE_DAYS=30`, `MAX_PROJECTS=200` per flow, both stores. Legacy env vars win when set,
with a startup warning; remove them from `.env.example`; update
`test_default_session_manager_is_durable_and_roomy`. Disk estimate: real sessions ~10–25 MB →
2–5 GB at 200; conversions ~125 KB. Pin orphan-upload cleanup to 24 h (it uses the session TTL
today, `main.py:90`). Eviction: never evict anything opened in the last 24 h; among the rest evict by
oldest `last_opened`, preferring delivered-and-unchanged only as a tie-breaker (a "delivered
first" rule would evict a delivered project being re-edited while abandoned test uploads
survive). The hub shows the effective limits, since a legacy `ILLUSTRATOR_CACHE_TTL_MINUTES=120`
would otherwise silently empty it every 2 hours. Disk estimates above come from test fixtures;
log real store sizes at startup before fixing the cap. Migration: lazy (v1 meta lists with null name/stage; first
save writes v2).

## 4. PRs

1. Storage safety (F2, F3).
2. Session meta v2 + stage derivation.
3. Conversion sidecar, list, name, delivered_at, GET conversion, placement GET/PUT.
4. `GET /api/projects` + lifetimes.
5. Shapefile routes (after 1).
6. Artwork routes + placement autosave (after 3).
Order: 1 → 2 → 4 and 1 → 3 → 6; 5 after 1. Hub (phase 7) needs 4 and 5.

## 5. Residual risks (after review)

URL shape and slugs are permanent once bookmarked; record schema tolerance (F2); autosave vs
undo; any listing path reaching `get()`; stale state across project switch (F1); `export_imdf`
is a GET that would now set delivered_at (prefetch/double-click); legacy env silently keeping
24 h; a 30-day cache of geometry from an older parser (add `parser_version`); concurrent export
and placement PUT without a lock; redirect loops between null stage and the resolver.
