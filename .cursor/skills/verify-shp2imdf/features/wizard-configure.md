# Configure wizard

The wizard lets a user set venue identity, confirm file types and floors, map unit codes, and generate draft IMDF features for review.

## Sub-features

- `wizard-venue` saves required venue name, category, locality, and country.
- `wizard-nav` switches sections from the `Sections` nav.
- `wizard-generate` runs `Generate & open Review` and opens `/p/<sessionId>/check`.

## How to get to it (user POV)

- After a successful standard import, the app navigates to `/p/<sessionId>/set-up`.
- Choose the `Configure` step when a session exists.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- A standard-import session is on `/p/<sessionId>/set-up` (run `drive import-shapefiles` first, or use the one-shot below).
- Tokyo Station fixtures were the source (stems `JRTokyoSta_*` auto-classify as unit/opening with levels).
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive wizard-configure`.

- **Venue name.** Fill `Venue Name *` with `Tokyo Station`. Run `getByLabel(/Venue Name/).fill('Tokyo Station')`.
- **Locality.** Fill `Locality *` with `Chiyoda-ku`. Run `getByLabel(/Locality/).first().fill('Chiyoda-ku')`. Country stays `JP`; category defaults to `transitstation`.
- **Save venue.** Nothing to click: the section autosaves 800 ms after typing stops. Wait for the footer text `Saved · HH:MM`.
- **Open summary.** Choose `Summary & Generate` in `Sections`. Run `getByRole('button', { name: 'Summary & Generate' }).click()`. Heading `Summary & Generate` appears and lists venue `Tokyo Station`.
- **Generate.** Choose `Generate & open Review`. Run `getByRole('button', { name: 'Generate & open Review' }).click()`. Wait until the URL is `/p/<sessionId>/check`.
- **Proof.** Capture review with `Export` visible. Write `artifacts/verify-shp2imdf/wizard-configure/`.

## Gotchas

- `Generate & open Review` stays disabled until venue name + locality + country, every file has a type, required files have a level, buildings are assigned (defaults to one building), and unit files have a `code_column` (wizard seed usually picks `COMPANY_CODE` on this fixture).
- Building names may be empty; a saved venue name satisfies the building naming check.
- A project is its URL: `/p/<sessionId>/set-up` reloads, and opens in a fresh tab, with the saved wizard state. `/p/<sessionId>` with no stage lands on the stage the project can open (Set up until a draft exists, then Check). `/p/<sessionId>/deliver` is Review with the export dialog open. The old `/wizard` and `/review` redirect to the project still in memory, else to `/`. An id the server no longer keeps opens the "This project is no longer kept on this PC" dialog.
- Do not move on before the footer says `Saved` and still claim venue persistence; generate uses server wizard state.
