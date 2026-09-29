# Place Illustrator artwork

The Illustrator screen converts a PDF-compatible `.ai` file, lets the user assign floors and place artwork on a map, and exports GeoPackage / shapefiles / QGIS. This map starts at opening the screen; full georeference is a later expansion.

## Sub-features

- `illustrator-open` reaches `/illustrator` from the hub.
- `illustrator-choose` shows `Choose file` and `#illustrator-georef-input`.
- `illustrator-skip-placement-save` never writes `data/placements.db` during verification.
- `illustrator-status` (by hand): each floor is Aligned or Needs alignment. Handles: on the Export tab the list `Floor status`, one row per floor with `data-floor-status="aligned" | "needs-alignment"` and a button `Review <floor>`; exporting with any row not aligned opens a dialog with `Export anyway`. The locate row shows `suggested · approximate`, or `[data-testid=lookup-failure]` when the filename found nothing (a synthetic name such as `0001_東京.ai` renamed to `0001_zzqx.ai`); the map then shows `[data-testid=lookup-failed]`. The top bar's `[data-testid=page-save-status]` reads `Saved · HH:MM`. `Relink to shared frame` opens `[data-testid=relink-preview]`; picking a saved placement opens `[data-testid=template-preview]` (look, do not apply someone's building on the shared PC).

## How to get to it (user POV)

- On the hub (`/`), choose `From Illustrator artwork`, or drop one `.ai`/`.pdf` on its drop zone (the file is converted on arrival).
- Open `/illustrator` directly.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- English UI.
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive illustrator-open`.

- **Enter.** From `/`, choose `From Illustrator artwork`. Run `getByRole('button', { name: /From Illustrator artwork/ }).click()`. URL is `/illustrator`.
- **Idle state.** Heading `Place Illustrator artwork` and button `Choose file` are visible. The file input id is `illustrator-georef-input`.
- **Do not save placements.** Leave named placement controls untouched.
- **Proof.** Write `artifacts/verify-shp2imdf/illustrator-open/` (folder name matches the drive id) showing the heading and `Choose file`. `IMDF Converter` remains in the shell header.

## Gotchas

- `.ai` files must be PDF-compatible. A random Illustrator file without PDF compatibility fails convert with that message.
- Placements are SQLite at `data/placements.db` (gitignored) and survive process restart. Saving a name collides with colleagues' building placements.
- Convert is a backend call; if the API is down the page shows a backend-unreachable error — run doctor rather than retrying the picker.
- Multi-floor box assignment and OSM/GSI placement are real user paths not yet in this map; do not report them verified by opening the idle screen.
