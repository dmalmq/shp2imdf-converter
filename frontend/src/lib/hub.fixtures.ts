import type { ProjectSummary } from "../api/client";

/** A shapefile project at Check with three errors; override what a test is about. */
export function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "s1",
    flow: "shapefiles",
    name: "東京駅",
    import_profile: "standard",
    stage: "check",
    updated_at: "2026-09-20T03:00:00Z",
    last_opened: "2026-09-20T03:00:00Z",
    blockers: 3,
    can_wait: 5,
    delivered_at: null,
    changed_since_delivery: false,
    expires_at: "2026-10-20T03:00:00Z",
    ...overrides
  };
}
