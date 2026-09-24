# Hub

Back to [overview](overview.md).

**Goal.** Home is the project hub from Figma 115:2: station projects with their four-stage
track, "Last opened", blockers, Continue/Open; "Start something new" with three routes and
a drop zone that works out which route a file belongs to.

**Changes.** New `pages/HubPage.tsx` at `/`; Upload moves to the Bring in stage.

**Verification.** Component tests over `ProjectSummary` fixtures; live: create two projects,
reload, both listed in order, Continue resumes at the right stage.
