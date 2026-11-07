import { isId } from "../home/workspace-api";

export type ProgressContext = {
  classId: string;
  assignmentId: string;
  studentId: string;
  projectId: string;
};

export function progressEditorUrl(context: ProgressContext): string {
  const params = new URLSearchParams({ ...context, review: "1" });
  return `/?${params}`;
}

export function reviewReturnUrl(params: URLSearchParams): string {
  const classId = params.get("classId"),
    assignmentId = params.get("assignmentId"),
    studentId = params.get("studentId"),
    projectId = params.get("projectId");
  if (
    params.get("review") !== "1" ||
    !isId(classId) ||
    !isId(assignmentId) ||
    !isId(studentId) ||
    !isId(projectId)
  )
    return "/home";
  return `/home?${new URLSearchParams({ classId, assignmentId, studentId, reviewProjectId: projectId })}`;
}
