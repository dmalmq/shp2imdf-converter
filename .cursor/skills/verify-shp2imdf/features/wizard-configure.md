# Configure wizard

The wizard lets a user set venue identity, confirm file types and floors, map unit codes, and generate draft IMDF features for review.

## Sub-features

- `wizard-venue` saves required venue name, category, locality, and country.
- `wizard-nav` switches sections from the `Sections` nav.
- `wizard-generate` runs `Confirm & Open Review` and opens `/review`.

## How to get to it (user POV)

- After a successful standard import, the app navigates to `/wizard`.
- Choose the `Configure` step when a session exists.

## Driving it with control.mjs

Preconditions:

- Doctor is OK.
- A standard-import session is on `/wizard` (run `drive import-shapefiles` first, or use the one-shot below).
- Tokyo Station fixtures were the source (stems `JRTokyoSta_*` auto-classify as unit/opening with levels).
- One-shot: `node .cursor/skills/verify-shp2imdf/scripts/control.mjs drive wizard-configure`.

- **Venue name.** Fill `Venue Name *` with `Tokyo Station`. Run `getByLabel(/Venue Name/).fill('Tokyo Station')`.
- **Locality.** Fill `Locality *` with `Chiyoda-ku`. Run `getByLabel(/Locality/).first().fill('Chiyoda-ku')`. Country stays `JP`; category defaults to `transitstation`.
- **Save venue.** Choose `Save Project Info`. Run `getByRole('button', { name: 'Save Project Info' }).click()`. The button may show `Saving...` then return to `Save Project Info`.
- **Open summary.** Choose `Summary & Generate` in `Sections`. Run `getByRole('button', { name: 'Summary & Generate' }).click()`. Heading `Step 10: Summary` appears and lists venue `Tokyo Station`.
- **Generate.** Choose `Confirm & Open Review`. Run `getByRole('button', { name: 'Confirm & Open Review' }).click()`. Wait until the URL is `/review`.
- **Proof.** Capture review with `Export` visible. Write `artifacts/verify-shp2imdf/wizard-configure/`.

## Gotchas

- `Confirm & Open Review` stays disabled until venue name + locality + country, every file has a type, required files have a level, buildings are assigned (defaults to one building), and unit files have a `code_column` (wizard seed usually picks `COMPANY_CODE` on this fixture).
- Building names may be empty; a saved venue name satisfies the building naming check.
- `/wizard` without a `sessionId` in client state redirects to `/`. Do not open `/wizard` in a fresh tab and expect the previous import.
- Do not skip Save Project Info and still claim venue persistence; generate uses server wizard state.
