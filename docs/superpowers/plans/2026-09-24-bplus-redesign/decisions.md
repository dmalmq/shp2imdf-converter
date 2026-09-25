# Decision trail

Back to [overview](overview.md).

| Date | Decision | Options | Choice | Reason |
|---|---|---|---|---|
| 2026-09-24 | Direction | Concepts A, B, C | B+ (B with A's top bar, logo, search) | Daniel's pick |
| 2026-09-24 | Artwork colour | signal orange, plum | Plum | Daniel: "I like the plum" |
| 2026-09-24 | Residuals | 3 pairs always, 2 when scale locked | 2 when locked | Locked scale leaves 3 unknowns, so 2 pairs over-determine the fit; Daniel approved |
| 2026-09-24 | Identity | "Working as" chip, none | None; sessions only | No logins exist |
| 2026-09-24 | Delivery strategy | incremental, big-bang branch, /v2 app | Incremental on main | Shippable, verifiable steps; one UI on the shared PC |
| 2026-09-24 | Verification harness | Playwright specs, repo driver | Extend `control.mjs` | It already launches and drives every flow; no specs exist |
| 2026-09-24 | Warning colour | keep #69's tokens, switch to B's ochre | Keep #69 (`warning` #CA8A04, `warning-foreground` #854D0E), adopt B's tint #F3E6C4 for warning surfaces | B's ochre text #8A5A0A and #69's #854D0E are near-identical; keeping them avoids reversing a same-day decision Daniel approved |
| 2026-09-25 | Project lifetimes | keep today's 24 h / 50 sessions and 2 h / 20 conversions, longer idle limits with a cap | 30 days after last opened, cap 200 per flow (sessions; conversions), nothing opened in the last 24 h ever evicted (the store overflows and logs instead) | Daniel's call: a hub is only useful if projects outlive a day; 200 real sessions is an estimated 2–5 GB, and the 24 h floor means the cap can never take work in progress. Legacy env vars still win when set, with a startup warning |
| 2026-09-25 | Artwork on the hub before `/a/:id` | list artwork cards opening a blank `/illustrator`, list shapefile projects only | Shapefile projects only (`GET /api/projects?flow=shapefiles`) until phase 14; the "From Illustrator artwork" route and `.ai`/`.pdf` drop routing stay | A card whose Continue cannot reopen its project is a card that does not open; phase 14 adds artwork cards together with the route that resumes them |
| 2026-09-25 | Bring in for new work | the plan's `/shapefiles/new`, `/p/new` | `/p/new` renders Bring in with no project (the store switches to none); `/p/:id/bring-in` stays the existing project's Bring in | Phase 5 fixed the shapefile routes as `/p/:id/<stage>`, so the new-work path sits beside them; `/p/new` redirected to `/` until the hub needed somewhere to send "From floor shapefiles" |
| 2026-09-25 | Hub drop-zone routing | ask the user, guess per file, route the whole drop | Route the whole drop: `.shp .dbf .shx .prj .cpg .qix .gpkg` → Bring in; one `.ai`/`.pdf` → artwork; `.imdf`, `*.imdf.zip`, or a zip whose central directory has `manifest.json` at the root (or under its single top folder) and no `.shp` → IMDF import; any other zip, including one holding both `manifest.json` and a `.shp`, → Bring in. Unknown files are left out and named in a notice; mixed routes, or two artworks/archives, are refused | An IMDF archive never carries a `.shp`, and Bring in reports on any zip it cannot read, so the ambiguous cases fall to the route that explains itself. The files ride in history state once and are then cleared, so Back or reload does not re-run them |
