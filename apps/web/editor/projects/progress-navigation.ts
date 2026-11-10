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

export function parseProgressContext(
  params: URLSearchParams,
  expectedProjectId: string,
): ProgressContext | null {
  const classId = params.get("classId"),
    assignmentId = params.get("assignmentId"),
    studentId = params.get("studentId"),
    projectId = params.get("projectId");
  if (
    ["review", "classId", "assignmentId", "studentId", "projectId"].some(
      (name) => params.getAll(name).length !== 1,
    ) ||
    params.get("review") !== "1" ||
    !isId(classId) ||
    !isId(assignmentId) ||
    !isId(studentId) ||
    !isId(projectId) ||
    projectId.toLowerCase() !== expectedProjectId.toLowerCase()
  )
    return null;
  return { classId, assignmentId, studentId, projectId };
}

export function reviewReturnUrl(params: URLSearchParams, role?: string): string {
  const context = parseProgressContext(params, params.get("projectId") ?? "");
  // Preserve assignment return context; ordinary admin visits return to their dashboard
  if (!context) return role === "Administrator" ? "/admin/dashboard" : "/home";
  const destination = new URLSearchParams({
    classId: context.classId,
    assignmentId: context.assignmentId,
  });
  if (role !== "Educator") {
    destination.set("studentId", context.studentId);
    destination.set("reviewProjectId", context.projectId);
  }
  return `/home?${destination}`;
}
