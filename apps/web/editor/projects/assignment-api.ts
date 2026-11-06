import type { EligibleStudent, ProjectClass } from "./new-project-form";

export type AssignmentSession = {
  userId: string;
  displayName: string;
  role: string;
  orgId: string | null;
  mustChangePassword?: boolean;
};
export type SourceProject = { projectId: string; title: string; revision: number };
export type AssignmentProject = { studentId: string; projectId: string; studentName?: string };
export type AssignmentDetails = {
  assignmentId: string;
  title: string;
  description: string;
  instructions: string;
  dueAtUnixSeconds: number;
  projects: AssignmentProject[];
};
export type PendingAssignment = {
  actorId: string;
  classId: string;
  body: {
    requestId: string;
    sourceProjectId: string;
    sourceRevision: number;
    dueAtUnixSeconds: number;
    title: string;
    description: string;
    instructions: string;
    studentIds: string[];
  };
};
export type AssignmentAttempt =
  | { kind: "confirmed"; assignmentId: string; projects: AssignmentProject[] }
  | { kind: "rejected"; message: string }
  | { kind: "unknown" };

async function readJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("The requested information is unavailable.");
  return response.json();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStudentName(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

async function pages(path: string, signal?: AbortSignal): Promise<unknown[]> {
  const items: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await readJson(url, signal);
    if (
      !record(page) ||
      !Array.isArray(page.items) ||
      !(page.nextCursor === null || typeof page.nextCursor === "string")
    )
      throw new Error("The response is unavailable.");
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("The response is unavailable.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

export async function assignmentSession(signal?: AbortSignal): Promise<AssignmentSession> {
  const value = await readJson("/api/v1/auth/session", signal);
  if (
    !record(value) ||
    typeof value.userId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.role !== "string" ||
    !(value.orgId === null || typeof value.orgId === "string")
  )
    throw new Error("The account session is unavailable.");
  return {
    userId: value.userId,
    displayName: value.displayName,
    role: value.role,
    orgId: value.orgId,
    mustChangePassword: value.mustChangePassword === true,
  };
}

export async function assignmentChoices(
  signal?: AbortSignal,
): Promise<{ classes: ProjectClass[]; projects: SourceProject[] }> {
  const [classes, projects] = await Promise.all([
    pages("/api/v1/classes", signal),
    pages("/api/v1/projects", signal),
  ]);
  if (
    classes.some(
      (row) => !record(row) || typeof row.id !== "string" || typeof row.name !== "string",
    ) ||
    projects.some(
      (row) =>
        !record(row) ||
        typeof row.projectId !== "string" ||
        typeof row.title !== "string" ||
        typeof row.revision !== "number" ||
        !Number.isSafeInteger(row.revision) ||
        !record(row.permissions) ||
        typeof row.permissions.canManage !== "boolean",
    )
  )
    throw new Error("The assignment choices are unavailable.");
  return {
    classes: classes.map((row) => ({
      id: (row as { id: string }).id,
      label: (row as { name: string }).name,
    })),
    projects: projects
      .filter((row) => (row as { permissions: { canManage: boolean } }).permissions.canManage)
      .map((row) => ({
        projectId: (row as SourceProject).projectId,
        title: (row as SourceProject).title,
        revision: (row as SourceProject).revision,
      })),
  };
}

export async function enrolledStudents(
  classId: string,
  signal?: AbortSignal,
): Promise<EligibleStudent[]> {
  const rows = await pages(
    `/api/v1/classes/${encodeURIComponent(classId)}/eligible-students`,
    signal,
  );
  if (
    rows.some(
      (row) =>
        !record(row) ||
        typeof row.userId !== "string" ||
        typeof row.userName !== "string" ||
        typeof row.enrolled !== "boolean",
    )
  )
    throw new Error("The class roster is unavailable.");
  return rows
    .filter((row) => (row as { enrolled: boolean }).enrolled)
    .map((row) => {
      const student = row as { userId: string; userName: string };
      return {
        id: student.userId,
        name: student.userName,
        account: student.userName,
        classIds: [classId],
      };
    });
}

function receipt(value: unknown, pending: PendingAssignment): AssignmentProject[] | null {
  if (
    !record(value) ||
    value.assignmentId !== pending.body.requestId ||
    !Array.isArray(value.projects)
  )
    return null;
  const expected = new Set(pending.body.studentIds);
  const projectIds = new Set<string>();
  const found = new Set<string>();
  for (const row of value.projects) {
    if (
      !record(row) ||
      typeof row.studentId !== "string" ||
      typeof row.projectId !== "string" ||
      !validStudentName(row.studentName) ||
      !expected.has(row.studentId) ||
      found.has(row.studentId) ||
      projectIds.has(row.projectId)
    )
      return null;
    found.add(row.studentId);
    projectIds.add(row.projectId);
  }
  return found.size === expected.size ? (value.projects as AssignmentProject[]) : null;
}

export async function submitAssignment(
  pending: PendingAssignment,
  previouslyUncertain: boolean,
): Promise<AssignmentAttempt> {
  try {
    const session = await assignmentSession();
    if (session.userId !== pending.actorId)
      return previouslyUncertain
        ? { kind: "unknown" }
        : {
            kind: "rejected",
            message: "The account changed. Reload before creating an assignment.",
          };
    const csrf = await readJson("/api/v1/auth/csrf");
    if (!record(csrf) || typeof csrf.requestToken !== "string")
      throw new Error("Missing request token.");
    const current = await assignmentSession();
    if (current.userId !== pending.actorId || current.mustChangePassword)
      return previouslyUncertain
        ? { kind: "unknown" }
        : {
            kind: "rejected",
            message: "The account changed. Reload before creating an assignment.",
          };
    let response: Response;
    try {
      response = await fetch(`/api/v1/classes/${encodeURIComponent(pending.classId)}/assignments`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": csrf.requestToken,
          "X-Spatia-Account": pending.actorId,
        },
        body: JSON.stringify(pending.body),
      });
    } catch {
      return { kind: "unknown" };
    }
    if (response.status === 200 || response.status === 201) {
      try {
        const projects = receipt(await response.json(), pending);
        if ((await assignmentSession()).userId !== pending.actorId) return { kind: "unknown" };
        return projects
          ? { kind: "confirmed", assignmentId: pending.body.requestId, projects }
          : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    }
    if (!previouslyUncertain && [400, 403, 404, 409, 413, 422].includes(response.status))
      return {
        kind: "rejected",
        message:
          response.status === 403 || response.status === 404
            ? "The assignment was not created. Check your access, refresh projects and classes, or cancel."
            : response.status === 413
              ? "The assignment is too large to send. Shorten the title, description or instructions and try again."
              : "The assignment was not created. Check the source revision, class and students, then try again.",
      };
    return { kind: "unknown" };
  } catch {
    return previouslyUncertain
      ? { kind: "unknown" }
      : {
          kind: "rejected",
          message: "The assignment request could not be sent. Your details are unchanged.",
        };
  }
}

function assignmentDetails(value: unknown): AssignmentDetails {
  if (
    !record(value) ||
    typeof value.assignmentId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.instructions !== "string" ||
    typeof value.dueAtUnixSeconds !== "number" ||
    !Number.isSafeInteger(value.dueAtUnixSeconds) ||
    !Array.isArray(value.projects) ||
    value.projects.some(
      (row) =>
        !record(row) ||
        typeof row.studentId !== "string" ||
        typeof row.projectId !== "string" ||
        !validStudentName(row.studentName),
    )
  )
    throw new Error("The assignment is unavailable.");
  return value as AssignmentDetails;
}

export async function listAssignments(
  classId: string,
  signal?: AbortSignal,
): Promise<AssignmentDetails[]> {
  return (await pages(`/api/v1/classes/${encodeURIComponent(classId)}/assignments`, signal)).map(
    assignmentDetails,
  );
}

export async function readAssignment(
  classId: string,
  assignmentId: string,
  signal?: AbortSignal,
): Promise<AssignmentDetails> {
  const value = assignmentDetails(
    await readJson(
      `/api/v1/classes/${encodeURIComponent(classId)}/assignments/${encodeURIComponent(assignmentId)}`,
      signal,
    ),
  );
  if (value.assignmentId !== assignmentId) throw new Error("The assignment is unavailable.");
  return value;
}
