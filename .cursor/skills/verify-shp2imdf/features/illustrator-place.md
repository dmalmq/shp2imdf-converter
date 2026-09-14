# Place Illustrator artwork

The Illustrator screen converts a PDF-compatible `.ai` file, lets the user assign floors and place artwork on a map, and exports GeoPackage / shapefiles / QGIS. This map starts at opening the screen; full georeference is a later expansion.

## Sub-features

- `illustrator-open` reaches `/illustrator` from Import.
- `illustrator-choose` shows `Choose .ai file` and `#illustrator-georef-input`.
- `illustrator-skip-placement-save` never writes `data/placements.db` during verification.

## How to get to it (user POV)

- On `/`, choose `Illustrator (.ai) → place on map`.
- Open `/illustrator` directly.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive illustrator-open`.

- **Enter.** From `/`, choose `Illustrator (.ai) → place on map`. Run `getByRole('button', { name: 'Illustrator (.ai) → place on map' }).click()`. URL is `/illustrator`.
- **Idle state.** Heading `Place Illustrator artwork` and button `Choose .ai file` are visible. The file input id is `illustrator-georef-input`.
- **Do not save placements.** Leave named placement controls untouched.
- **Proof.** Write `artifacts/verify-shp2imdf/illustrator-open/` (folder name matches the drive id) showing the heading and `Choose .ai file`. `IMDF Converter` remains in the shell header.

## Gotchas

- `.ai` files must be PDF-compatible. A random Illustrator file without PDF compatibility fails convert with that message.
- Placements are SQLite at `data/placements.db` (gitignored) and survive process restart. Saving a name collides with colleagues' building placements.
- Convert is a backend call; if the API is down the page shows a backend-unreachable error — run doctor rather than retrying the picker.
- Multi-floor box assignment and OSM/GSI placement are real user paths not yet in this map; do not report them verified by opening the idle screen.
