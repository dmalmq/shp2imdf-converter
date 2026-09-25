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
