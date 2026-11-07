import type { AssignmentDetails } from "../projects/assignment-api";
import type { ProjectSummary } from "./workspace-api";

export type StudentAssignment = { className: string; details: AssignmentDetails };
export type StudentProjectRow = { project: ProjectSummary; assignment: StudentAssignment | null };

export function studentProjectRows(
  studentId: string,
  projects: readonly ProjectSummary[],
  assignments: readonly StudentAssignment[],
): StudentProjectRow[] {
  const mappings = new Map<string, StudentAssignment | null>();
  for (const assignment of assignments) {
    for (const project of assignment.details.projects) {
      if (project.studentId !== studentId) continue;
      mappings.set(project.projectId, mappings.has(project.projectId) ? null : assignment);
    }
  }
  return projects.map((project) => ({
    project,
    assignment: mappings.get(project.projectId) ?? null,
  }));
}
