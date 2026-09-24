# Handover

Back to [overview](overview.md).

**Goal.** "Last time on 東京駅": last session date and duration, an automatic change log,
and an optional unsigned note, shown when a project is reopened.

**Changes.** Backend appends compact change events per session (bounded); the note is stored
on the project; a Welcome back view on resume.

**Verification.** TDD on the event log bounds; live: make changes, leave, resume, see them.
