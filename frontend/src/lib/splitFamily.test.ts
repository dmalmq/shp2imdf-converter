import type { ProjectSummary } from "../api/client";
import { splitFamily } from "./splitFamily";

function project(id: string, name: string, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    flow: "shapefiles",
    name,
    import_profile: "standard",
    stage: "set-up",
    updated_at: null,
    last_opened: "2026-10-19T00:00:00Z",
    blockers: null,
    can_wait: null,
    delivered_at: null,
    changed_since_delivery: false,
    expires_at: "2026-11-19T00:00:00Z",
    split_parent_id: null,
    ...overrides
  };
}

const projects = [
  project("p", "Shinjuku"),
  project("w", "West", { split_parent_id: "p", stage: "deliver", delivered_at: "2026-10-19T01:00:00Z" }),
  project("e", "East", { split_parent_id: "p" }),
  project("n", "North", { split_parent_id: "p", stage: "bring-in" }),
  project("x", "Other station", { split_parent_id: "q" })
];

describe("split family", () => {
  test("lists the other buildings of the same import by name, and the import itself", () => {
    const family = splitFamily("w", projects);

    expect(family?.parent?.name).toBe("Shinjuku");
    expect(family?.siblings.map((item) => item.name)).toEqual(["East", "North"]);
    expect(family?.siblings[1].href).toBe("/p/n/bring-in");
  });

  test("a project that was not split off has none, and a gone import still leaves the siblings", () => {
    expect(splitFamily("p", projects)).toBeNull();
    expect(splitFamily("e", projects.filter((item) => item.id !== "p"))).toMatchObject({ parent: null });
  });
});
