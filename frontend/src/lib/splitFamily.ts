import type { ProjectSummary } from "../api/client";
import { toHubProject, type HubProject } from "./hub";

export type SplitFamily = {
  /** The import the buildings were split from, when it is still listed. */
  parent: HubProject | null;
  /** Every other building split from the same import, by name. */
  siblings: HubProject[];
};

/** The buildings split from the same import as `id`, or null for a project that was not split off. */
export function splitFamily(id: string, projects: ReadonlyArray<ProjectSummary>): SplitFamily | null {
  const parentId = projects.find((project) => project.id === id)?.split_parent_id;
  if (!parentId) return null;
  const parent = projects.find((project) => project.id === parentId);
  const siblings = projects
    .filter((project) => project.id !== id && project.split_parent_id === parentId)
    .map(toHubProject)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
  return { parent: parent ? toHubProject(parent) : null, siblings };
}
