# Illustrator to shapefile workflow review

Reviewed 25 September 2026 against the current source and the local app at `http://localhost:5310/illustrator`.

## Recommendation

Guide users through placing a reference level at its real-world location, aligning the remaining levels to that reference, and reviewing every level before export. Most of the underlying tools already exist. The main work is making their order, scope, and results clear.

## What already works

The current interface has file drop, page thumbnails, floor naming and exclusion, workflow stages, undo/redo, group and individual movement, pinning, outline display, zoom to artwork, reference overlays, vertex snapping for control points, residuals, and matching against another floor. Shape matching supports both outlines and shared areas. Export defaults to shapefile and explains its suggested coordinate system.

These are substantial improvements over the September 14 audit. That audit's obsolete findings should not be treated as current requirements.

## Highest-priority findings

### 1. Advanced scale can change a different floor

**Confirmed in the live interface.** On the three-page sample, 2F and 3F started unlinked. I selected 2F, switched to Individual, opened Advanced, unlocked scale, entered 500 and clicked Apply. 2F stayed at 1:1000; selecting 1F showed it had changed to 1:500. The scale change was undone afterward.

The advanced actions `setDrawingScale` and `calibrateDistance` update the shared frame without carrying the current adjustment mode. Rotation already distinguishes individual and group operations.

**Change:** make every placement control use the same explicit scope. Display “Editing 2F only” or “Editing linked levels: 1F, 2F, 3F” beside the controls. Changing an individual level's scale must leave all other levels unchanged. Provide a preview for rejoining the group because that operation can change placement.

Sources: `frontend/src/components/illustrator/ScaleAndFitPanel.tsx:145`, `frontend/src/hooks/useIllustratorPlacement.ts:359`, and `frontend/src/components/illustrator/TransformPanel.tsx`.

### 2. Export looks ready before placement is reviewed

**Confirmed in the live interface.** Import warned that pages 2 and 3 did not match page 1. Without adding control points or aligning the floors, opening Export enabled “Export 3 floors” and marked “Place on map” done. No per-floor alignment warning appeared in Export. I did not download the sample output.

The export button checks whether an output format is selected. The progress rail derives its state from which tab is open. Neither represents a user's placement review.

**Change:** track separate states for approximate location, alignment, and review. Give each floor a visible status, such as “Needs alignment”, “Aligned, needs review”, and “Reviewed”. Show an export checklist with a direct “Review 2F” action. Require an explicit acknowledgment for exporting unreviewed floors; do not call a floor accurate merely because it has been moved or pinned. Reopen review when its transform or reference changes.

Sources: `frontend/src/components/illustrator/ExportPanel.tsx:86`, `frontend/src/pages/IllustratorPage.tsx:432`.

### 3. The useful next step is hidden behind a method tab

**Confirmed in the live interface.** Selecting the unaligned 2F initially shows Control points. Opening Shape match reveals the much more relevant “Match 2F to 1F” action and an explanation that this floor did not stack.

**Change:** show a persistent floor list with the recommended action for each level. Selecting a floor that needs stacking should open “Align to reference level” directly. Keep an alternative method available. Use a level picker with thumbnails, visibility, review status, and locking instead of relying on the small unlinked dot in the map toolbar.

Sources: `frontend/src/components/illustrator/ScaleAndFitPanel.tsx:58`, `frontend/src/components/illustrator/ShapeMatchPanel.tsx`, `frontend/src/components/illustrator/PlacementMap.tsx:1085`.

## Proposed user journey

1. **Import and identify levels.** Keep page thumbnails and automatic naming. Clearly support both one page per level and several plans on one page. Highlight which shapes will be included or excluded when drawing floor boxes. Allow returning to floor assignment with a preview of what that edit will invalidate.
2. **Confirm the building location.** Show the full selected search result, locality, and map pin. Label filename lookup as a suggested approximate location. Provide search, a map placement action, and coordinate entry. If lookup fails, say so visibly; the synthetic filename produced an ordinary-looking placement at the default Tokyo coordinates after lookup settled.
3. **Choose and place a reference level.** Recommend a level with identifiable features in a trusted reference dataset, and let the user choose another. Confirm the drawing scale or calibrate it by clicking two endpoints and entering a known distance in metres. Fit matching points or preview a suggested outline match. Preserve the existing scale-and-rotation geometry model unless the user has a specific reason to allow distortion.
4. **Align the other levels.** Offer “Align 2F to 1F”, using shared structural points, outlines, or an area. Show only the selected and reference levels by default during this operation. Keep the accepted reference level fixed. Review suggested alignment before applying it. Permit genuinely different footprints and independently scaled drawings.
5. **Review and export.** Step through each level, compare it with the reference, check remaining mismatches, and explicitly mark it reviewed. Export shows the level list, output coordinate system, filenames, and unresolved issues.

## Precision improvements

- **Separate the plan and target during point picking.** Offer a split view for “click the plan point, then its matching reference point”, with zoom and visible snapping feedback. Keep the overlay view for final comparison. Existing vertex snapping should be retained.
- **Allow exact coordinates for a selected point.** Accept latitude/longitude with explicit labels, or projected X/Y with the selected CRS's axis labels and units. Validate coordinate order and plausible ranges. Keep the point's coordinate system distinct from the export coordinate system.
- **Clarify the coordinate readout.** The map displays latitude/longitude degrees beside the working CRS code, such as EPSG:6677. Label those degrees as geographic coordinates and show projected coordinates separately. The map readout should also say whether it refers to the cursor, anchor, or map center.
- **Add finer nudges.** Current arrows move 1 m and Shift+arrows 10 m. Offer a visible step selector, for example 0.01, 0.1, 1, and 10 m, and numeric horizontal offsets. Small increments help manipulation but do not establish survey accuracy.
- **Explain fit quality.** Keep RMSE and individual residuals, but add plain-language guidance, point coverage, the reference source, and an independent check point where available. Use a project-specific tolerance. Neither a small residual nor a high outline overlap proves absolute accuracy.
- **Make comparison easier.** Retain outline mode and “Only this floor”; add separate opacity controls for the active and reference levels and a quick before/after comparison. Keep the reference level selectable independently of which level is being edited.

Manual coordinate entry, point editing, snapping, and retained control points have established precedents in [QGIS's Georeferencer](https://docs.qgis.org/3.44/en/docs/user_manual/managing_data_source/georeferencer.html). The recommendations above adapt those patterns to this app's floor workflow.

## Recovery and repeat work

Placement editing currently lives in component state. The named placement library stores transforms and artwork bounds; it is not a complete resumable project with assignments, control points, references, and review history.

Add draft autosave and resume, keeping a deliberate “Save building template” action for reuse. Offer matching templates after import and floor identification, before users redo placement. Preview floor mapping and drawing differences before applying a template. Currently the library applies transforms before displaying a mismatch warning.

Source: `frontend/src/components/illustrator/PlacementLibrary.tsx:77` and `frontend/src/hooks/useIllustratorPlacement.ts:195`.

## Suggested delivery order

| Priority | Deliverable | Acceptance example |
| --- | --- | --- |
| First | Consistent individual/group scope | Changing 2F scale in Individual changes only 2F. |
| First | Per-level review and export checklist | Opening Export never marks an untouched level reviewed. |
| Next | Guided reference-level alignment | Selecting an unaligned level opens its recommended matching action. |
| Next | Clear location confirmation and exact coordinate entry | A known plan point can be assigned coordinates with explicit CRS and units. |
| Next | Point picking and fine adjustment | Users can select precise paired points and adjust by less than a metre. |
| Then | Draft recovery and template reuse | Reopening restores assignments, controls, references, and review status. |

## Review scope and limitations

The browser walkthrough used the repository's synthetic three-page Illustrator/PDF fixture at 1440 × 960. It covered import, floor assignment, placement controls, Individual scale application, floor matching UI, and export readiness. It did not establish real-world positional accuracy, complete a surveyed-building alignment, or validate generated shapefiles in GIS software.

The local app initially failed because declared font dependencies were missing. Installing the declared dependencies restored the app. No application source or package manifests were edited. Named saved placements were not changed. The local servers started for this review were stopped afterward.
