import { localDateToDueUnixSeconds, localDeadlineToUnixSeconds } from "./deadline";

// UI data contracts; the host maps them to the SCRUM-161 API.
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
  // A local date and time selected on this device, not a UTC calendar string.
  dueDate: string;
  classId: string;
  imageType: string;
  // Encoded and saved with the source project before students are assigned
  coverImage?: File;
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
  dateOnly = false,
):
  | { ok: true; value: NewProjectDraft }
  | { ok: false; field: keyof NewProjectDraft; message: string } {
  for (const field of ["title", "description", "instructions"] as const) {
    if (!draft[field].trim()) return { ok: false, field, message: `Enter a project ${field}.` };
  }
  if (
    (dateOnly
      ? localDateToDueUnixSeconds(draft.dueDate)
      : localDeadlineToUnixSeconds(draft.dueDate)) === null
  )
    return {
      ok: false,
      field: "dueDate",
      message: dateOnly ? "Choose a valid due date." : "Choose a valid local due date and time.",
    };
  if (!classes.some((item) => item.id === draft.classId))
    return { ok: false, field: "classId", message: "Choose an available class." };
  const eligibleIds = new Set(
    students
      .filter((student) => student.classIds.includes(draft.classId))
      .map((student) => student.id),
  );
  if (
    !draft.studentIds.length ||
    draft.studentIds.length > 20 ||
    new Set(draft.studentIds).size !== draft.studentIds.length ||
    draft.studentIds.some((id) => !eligibleIds.has(id))
  )
    return {
      ok: false,
      field: "studentIds",
      message:
        "Select up to 20 students available in the chosen class. The roster may have changed.",
    };
  if (!["Cover image", "360°"].includes(draft.imageType))
    return { ok: false, field: "imageType", message: "Choose an available image type." };
  return { ok: true, value: { ...draft, studentIds: [...draft.studentIds] } };
}
