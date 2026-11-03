import type { ProjectDocument } from "./project-types";

// Encode an already validated document. Empty extensions must not alter released scenes.
// Validation budgets and file/recovery writes share these exact bytes.
export function encodeProjectJson(project: ProjectDocument): string {
  return JSON.stringify({
    ...project,
    scenes: project.scenes.map(({ hotspots, interactions, ...scene }) => ({
      ...scene,
      ...(hotspots.length ? { hotspots } : {}),
      ...(interactions.length ? { interactions } : {}),
    })),
  });
}
