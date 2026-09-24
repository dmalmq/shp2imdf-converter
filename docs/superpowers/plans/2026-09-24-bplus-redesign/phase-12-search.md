# Search and commands

Back to [overview](overview.md).

**Goal.** Ctrl K search with the empty state (recents, next fix, actions), grouped results
(Stations, Floors, Issues, Files, Actions) and typed commands with a plain-sentence preview,
Apply, and Undo.

**Data structures.** `SearchItem = { kind, label, detail, run }`; a command grammar
`verb target [to value] [flag]` parsed into a typed `Command` that produces a `Preview`.

**Verification.** Parser table tests; live: "東京駅 1F", "overlap", a filename, and
"assign 屋外 to 1F outdoor" each land where the design says.

**Design gate.** `architect` for the grammar; `interrogate` before shipping.
