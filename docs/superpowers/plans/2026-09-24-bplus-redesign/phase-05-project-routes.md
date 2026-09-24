# Project-addressed routes

Back to [overview](overview.md).

**Goal.** A project is a URL: reload, back/forward and resume from the hub all work.

**Changes.** Routes become `/p/:sessionId/{bring-in,set-up,check,deliver}` and
`/a/:conversionId/{bring-in,name-floors,place,deliver}`; the store is hydrated from the URL
instead of holding the only copy of the id. Old routes redirect.

**Data structures.** `ProjectRef = { kind: "shapefiles", sessionId } | { kind: "artwork",
conversionId }`.

**Verification.** Tests for URL to store hydration and redirects; live: reload on every stage
keeps the project; an expired id shows the existing session-expired dialog.

**Design gate.** `architect` and `interrogate` before implementation.
