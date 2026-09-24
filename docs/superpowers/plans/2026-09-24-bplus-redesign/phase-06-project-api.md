# Project listing API and lifetimes

Back to [overview](overview.md).

**Goal.** `GET /api/projects` lists shapefile sessions and artwork conversions cheaply, with
name, flow, stage, last opened, blocker count and delivered state; lifetimes long enough for
a hub.

**Changes.**
- Session `.meta.json` and `SessionSummary` gain `name`, `stage`, `updated_at`, `blockers`,
  `delivered_at`, written on save; the list reads meta files only.
- `ConversionStore` gains a list method and a name.
- Export endpoints record `delivered_at`.
- Lifetimes become configuration with defaults Daniel chooses (open decision 1).

**Data structures.** `ProjectSummary = { id, flow, name, stage, updated_at, last_opened,
blockers, can_wait, delivered_at? }`.

**Verification.** TDD: listing never parses a full session file (extend the existing
no-reparse test); stage derivation table-tested; pruning honours the new lifetimes.

**Design gate.** `architect` and `interrogate`.
