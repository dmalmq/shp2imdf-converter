# Illustrator route in B+

Back to [overview](overview.md).

**Goal.** Figma page 112:2 calls for:
- four artwork stages;
- box splitting on Name floors;
- one Align panel (Move / Control points / Shape match);
- a to-do list counting floors placed;
- plum artwork;
- pinned floors drawn dashed;
- a per-floor fit table on Deliver.

**From the workflow review.** The [Illustrator workflow review](illustrator-review-2026-09-25.md) of 2026-09-25 found problems that this phase fixes. Its first finding, that Individual scale changed a different floor, ships separately as a bug fix before this phase.

- **Per-floor status.** Each floor shows "Needs alignment" or "Aligned". The status comes from the floor's placement, not from which tab is open, and it reopens when the floor's transform or reference changes. Moving or pinning a floor does not count as aligning it. Floors don't need a separate "mark reviewed" click.
- **Export checklist.** Deliver lists every floor with its status. An unaligned floor gets a "Review 2F" action that jumps to it. Exporting while any floor is unaligned needs one explicit confirmation. Opening Deliver never marks a floor as done.
- **Recommended action first.** Selecting a floor that did not stack opens "Align 2F to 1F" in the Align panel directly, not Control points. The other methods stay one click away.
- **Visible location-lookup failure.** When the filename lookup fails, say so. Label a successful lookup as a suggested, approximate location. Never fall back silently to the default Tokyo coordinates.
- **Draft autosave and resume at `/a/:id`.** Store assignments, per-floor transforms, control points, references and status with the artwork project, so reopening restores them. This is what lets the hub list artwork cards again (see decisions.md, "Artwork on the hub before `/a/:id`").
- **Template mismatch before apply.** The placement library shows the floor-mapping and drawing differences before it applies a saved template, not after.

**After this phase.** These are small, independent follow-ups:
- a nudge step selector (0.01 / 0.1 / 1 / 10 m);
- coordinate readouts labelled as geographic or projected, and as cursor, anchor or centre;
- plain-language guidance next to RMSE and the residuals.

**Deferred** until colleagues ask for them:
- a split view for point picking;
- exact coordinate entry for a point;
- independent check points and project tolerances;
- per-level opacity and before/after comparison;
- a preview of what editing floor assignments would invalidate.

**Verification.**
- `pytest -m georef`, similarity tests, and live placement with the verify driver's Illustrator feature file.
- Live, on the three-page sample:
  - with 2F unaligned, Deliver shows "Needs alignment" and a working "Review 2F";
  - exporting asks for confirmation;
  - after aligning 2F, the status reads "Aligned", and moving it again reopens it;
  - reloading `/a/:id` restores every floor's placement and status;
  - a synthetic filename shows the lookup failure.
