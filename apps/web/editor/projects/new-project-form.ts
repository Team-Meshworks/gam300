// UI data contracts, not a wire format for the pending SCRUM-161 API
export type ProjectClass = Readonly<{ id: string; label: string }>;
export type EligibleStudent = Readonly<{
  id: string;
  name: string;
  account: string;
  classIds: readonly string[];
}>;
export type NewProjectDraft = Readonly<{
  title: string;
  description: string;
  instructions: string;
  // Preserve the calendar date until the backend's timezone/cutoff contract is agreed
  dueDate: string;
  classId: string;
  imageType: string;
  studentIds: readonly string[];
}>;
export type ProjectCreationResult =
  | { kind: "created"; projectId: string }
  | { kind: "rejected"; message: string }
  | { kind: "unknown" };

export function validateNewProject(
  draft: NewProjectDraft,
  classes: readonly ProjectClass[],
  students: readonly EligibleStudent[],
):
  | { ok: true; value: NewProjectDraft }
  | { ok: false; field: keyof NewProjectDraft; message: string } {
  for (const field of ["title", "description", "instructions"] as const) {
    if (!draft[field].trim()) return { ok: false, field, message: `Enter a project ${field}.` };
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.dueDate);
  const date = new Date(`${draft.dueDate}T00:00:00Z`);
  if (
    !parts ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== draft.dueDate
  )
    return { ok: false, field: "dueDate", message: "Choose a valid due date." };
  if (!classes.some((item) => item.id === draft.classId))
    return { ok: false, field: "classId", message: "Choose an available class." };
  if (
    !draft.studentIds.length ||
    new Set(draft.studentIds).size !== draft.studentIds.length ||
    draft.studentIds.some(
      (id) =>
        !students.some((student) => student.id === id && student.classIds.includes(draft.classId)),
    )
  )
    return {
      ok: false,
      field: "studentIds",
      message: "Select students available in the chosen class. The roster may have changed.",
    };
  if (!["Cover image", "Gallery", "360°"].includes(draft.imageType))
    return { ok: false, field: "imageType", message: "Choose an available image type." };
  return { ok: true, value: { ...draft, studentIds: [...draft.studentIds] } };
}
