# Testing

Back to [overview](overview.md).

Gates on every PR, run from the repo root unless noted:

- `pytest` (and `pytest -m georef` when the Illustrator route or its maths is touched).
- `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npx tsc --noEmit -p tsconfig.node.json`.
  Never `-p .`: `tsconfig.json` is `files: []` and checks nothing.
- `cd frontend && npx vitest run`.
- The phase 1 capture script: before/after screenshots of the touched screens in light/dark
  and EN/日本語, reviewed side by side against the Figma frames the phase names.

Merge rule: an independent three-lane verdict (gates re-run at the head SHA, a live run on the
real app against main, and a diff audit), pinned to the head SHA and posted on the PR before
merge. Findings go back to the PR's owner.
