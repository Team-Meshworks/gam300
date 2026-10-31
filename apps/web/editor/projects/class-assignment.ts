import type { ProjectClass, EligibleStudent } from "./new-project-form";

// Host-authorized choices and UI results; the backend wire contract is still pending
export type AssignmentProject = Readonly<{
  id: string;
  title: string;
  classIds: readonly string[];
}>;
export type ClassAssignmentDraft = Readonly<{
  projectId: string;
  classId: string;
  studentIds: readonly string[];
}>;
export type ClassAssignmentResult =
  { kind: "assigned" } | { kind: "rejected"; message: string } | { kind: "unknown" };

export function validateClassAssignment(
  draft: ClassAssignmentDraft,
  projects: readonly AssignmentProject[],
  classes: readonly ProjectClass[],
  students: readonly EligibleStudent[],
): { ok: true; value: ClassAssignmentDraft } | { ok: false; message: string } {
  const project = projects.find((project) => project.id === draft.projectId);
  if (!project) return { ok: false, message: "Choose a project available for assignment." };
  if (
    !classes.some((item) => item.id === draft.classId) ||
    !project.classIds.includes(draft.classId)
  )
    return { ok: false, message: "Choose a class available for this project." };
  const eligibleIds = new Set(
    students
      .filter((student) => student.classIds.includes(draft.classId))
      .map((student) => student.id),
  );
  if (
    !draft.studentIds.length ||
    new Set(draft.studentIds).size !== draft.studentIds.length ||
    draft.studentIds.some((id) => !eligibleIds.has(id))
  )
    return {
      ok: false,
      message: "Select students available in the chosen class. The roster may have changed.",
    };
  return { ok: true, value: { ...draft, studentIds: [...draft.studentIds] } };
}
