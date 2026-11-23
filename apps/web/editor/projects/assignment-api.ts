import { isRecord, readField } from "../../shared/project/validation-helpers";
import { validProjectImage, type ProjectImage } from "./project-image";
import { combineAbortSignals } from "../../shared/network/abort-signals";
import type { EligibleStudent, ProjectClass } from "./new-project-form";

export type AssignmentSession = {
  userId: string;
  displayName: string;
  userName?: string;
  role: string;
  orgId: string | null;
  orgName?: string | null;
  mustChangePassword?: boolean;
};
export type SourceProject = {
  projectId: string;
  title: string;
  revision: number;
};
const reviewStates = ["draft", "outdated", "pending", "approved", "returned", "revoked"] as const;
export type AssignmentProject = {
  studentId: string;
  projectId: string;
  studentName?: string;
  studentUserName?: string;
  reviewState?: (typeof reviewStates)[number] | null;
  approvalStatus?:
    | "not-submitted"
    | "awaiting-approval"
    | "approved"
    | "returned"
    | "revoked"
    | "changes-since-submission";
  published?: boolean;
  isPublic?: boolean;
};
export type AssignmentDetails = {
  image?: ProjectImage | null;
  assignmentId: string;
  title: string;
  description: string;
  instructions: string;
  assignedBy?: string | null;
  dueAtUnixSeconds: number;
  revision?: number;
  sourceProjectId?: string | null;
  organizationName?: string;
  creatorName?: string;
  creatorUserName?: string;
  projects: AssignmentProject[];
};
export type PendingAssignment = {
  actorId: string;
  classId: string;
  sourceSelection?: string;
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

async function readJson(
  request: typeof fetch,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await request(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? combineAbortSignals([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("The requested information is unavailable.");
  return response.json();
}

function validStudentName(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

async function pages(
  request: typeof fetch,
  path: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const items: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await readJson(request, url, signal);
    if (
      !isRecord(page) ||
      !("items" in page) ||
      !("nextCursor" in page) ||
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

export async function assignmentSession(
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<AssignmentSession> {
  const value = await readJson(request, "/api/v1/auth/session", signal);
  if (
    !isRecord(value) ||
    !("userId" in value) ||
    !("displayName" in value) ||
    !("role" in value) ||
    !("orgId" in value) ||
    typeof value.userId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.role !== "string" ||
    !(value.orgId === null || typeof value.orgId === "string")
  )
    throw new Error("The account session is unavailable.");
  const userName = readField(value, "userName");
  const orgName = readField(value, "orgName");
  return {
    userId: value.userId,
    displayName: value.displayName,
    ...(typeof userName === "string" && userName.trim() ? { userName: userName } : {}),
    role: value.role,
    orgId: value.orgId,
    orgName: typeof orgName === "string" && orgName.trim() ? orgName : null,
    mustChangePassword: readField(value, "mustChangePassword") === true,
  };
}

export async function assignmentChoices(
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<{ classes: ProjectClass[]; projects: SourceProject[] }> {
  const [classes, projects] = await Promise.all([
    pages(request, "/api/v1/classes", signal),
    pages(request, "/api/v1/projects", signal),
  ]);
  if (
    classes.some(
      (row) =>
        !isRecord(row) ||
        !("id" in row) ||
        !("name" in row) ||
        typeof row.id !== "string" ||
        typeof row.name !== "string",
    ) ||
    projects.some(
      (row) =>
        !isRecord(row) ||
        !("projectId" in row) ||
        !("title" in row) ||
        !("revision" in row) ||
        !("permissions" in row) ||
        typeof row.projectId !== "string" ||
        typeof row.title !== "string" ||
        typeof row.revision !== "number" ||
        !Number.isSafeInteger(row.revision) ||
        !isRecord(row.permissions) ||
        !("canManage" in row.permissions) ||
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
  request: typeof fetch = fetch,
): Promise<EligibleStudent[]> {
  const rows = await pages(
    request,
    `/api/v1/classes/${encodeURIComponent(classId)}/eligible-students`,
    signal,
  );
  if (
    rows.some(
      (row) =>
        !isRecord(row) ||
        !("userId" in row) ||
        !("userName" in row) ||
        !("enrolled" in row) ||
        typeof row.userId !== "string" ||
        typeof row.userName !== "string" ||
        ("displayName" in row && row.displayName != null && typeof row.displayName !== "string") ||
        typeof row.enrolled !== "boolean",
    )
  )
    throw new Error("The class roster is unavailable.");
  return rows
    .filter((row) => (row as { enrolled: boolean }).enrolled)
    .map((row) => {
      const student = row as {
        userId: string;
        userName: string;
        displayName?: string | null;
      };
      return {
        id: student.userId,
        name: student.displayName?.trim() || student.userName,
        account: student.userName,
        classIds: [classId],
      };
    });
}

function receipt(value: unknown, pending: PendingAssignment): AssignmentProject[] | null {
  if (
    !isRecord(value) ||
    !("assignmentId" in value) ||
    !("projects" in value) ||
    value.assignmentId !== pending.body.requestId ||
    !Array.isArray(value.projects)
  )
    return null;
  const expected = new Set(pending.body.studentIds);
  const projectIds = new Set<string>();
  const found = new Set<string>();
  for (const row of value.projects) {
    if (
      !isRecord(row) ||
      !("studentId" in row) ||
      !("projectId" in row) ||
      typeof row.studentId !== "string" ||
      typeof row.projectId !== "string" ||
      !validStudentName(readField(row, "studentName")) ||
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
  request: typeof fetch = fetch,
): Promise<AssignmentAttempt> {
  try {
    const session = await assignmentSession(undefined, request);
    if (session.userId !== pending.actorId)
      return previouslyUncertain
        ? { kind: "unknown" }
        : {
            kind: "rejected",
            message: "The account changed. Reload before creating an assignment.",
          };
    const csrf = await readJson(request, "/api/v1/auth/csrf");
    if (!isRecord(csrf) || !("requestToken" in csrf) || typeof csrf.requestToken !== "string")
      throw new Error("Missing request token.");
    const current = await assignmentSession(undefined, request);
    if (current.userId !== pending.actorId || current.mustChangePassword)
      return previouslyUncertain
        ? { kind: "unknown" }
        : {
            kind: "rejected",
            message: "The account changed. Reload before creating an assignment.",
          };
    let response: Response;
    try {
      response = await request(
        `/api/v1/classes/${encodeURIComponent(pending.classId)}/assignments`,
        {
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
        },
      );
    } catch {
      return { kind: "unknown" };
    }
    if (response.status === 200 || response.status === 201) {
      try {
        const projects = receipt(await response.json(), pending);
        if ((await assignmentSession(undefined, request)).userId !== pending.actorId)
          return { kind: "unknown" };
        return projects
          ? {
              kind: "confirmed",
              assignmentId: pending.body.requestId,
              projects,
            }
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

export function assignmentDetails(value: unknown): AssignmentDetails {
  if (!isRecord(value)) throw new Error("The assignment is unavailable.");
  const assignedBy = readField(value, "assignedBy");
  const revision = readField(value, "revision");
  const sourceProjectId = readField(value, "sourceProjectId");
  const organizationName = readField(value, "organizationName");
  const creatorName = readField(value, "creatorName");
  if (
    !("assignmentId" in value) ||
    !("title" in value) ||
    !("description" in value) ||
    !("instructions" in value) ||
    !("dueAtUnixSeconds" in value) ||
    !("projects" in value) ||
    !validProjectImage(readField(value, "image")) ||
    typeof value.assignmentId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.instructions !== "string" ||
    !(assignedBy == null || typeof assignedBy === "string") ||
    typeof value.dueAtUnixSeconds !== "number" ||
    !Number.isSafeInteger(value.dueAtUnixSeconds) ||
    (revision !== undefined &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) ||
    (sourceProjectId != null && typeof sourceProjectId !== "string") ||
    (organizationName !== undefined && typeof organizationName !== "string") ||
    (creatorName !== undefined && typeof creatorName !== "string") ||
    !validStudentName(readField(value, "creatorUserName")) ||
    !Array.isArray(value.projects) ||
    value.projects.some((row: unknown) => {
      if (!isRecord(row)) return true;
      const reviewState = readField(row, "reviewState");
      const approvalStatus = readField(row, "approvalStatus");
      const published = readField(row, "published");
      const isPublic = readField(row, "isPublic");
      return (
        typeof readField(row, "studentId") !== "string" ||
        typeof readField(row, "projectId") !== "string" ||
        !validStudentName(readField(row, "studentName")) ||
        !validStudentName(readField(row, "studentUserName")) ||
        !(reviewState == null || reviewStates.some((state) => state === reviewState)) ||
        (approvalStatus !== undefined &&
          ![
            "not-submitted",
            "awaiting-approval",
            "approved",
            "returned",
            "revoked",
            "changes-since-submission",
          ].includes(String(approvalStatus))) ||
        (published !== undefined && typeof published !== "boolean") ||
        (isPublic !== undefined && typeof isPublic !== "boolean")
      );
    })
  )
    throw new Error("The assignment is unavailable.");
  return value as AssignmentDetails;
}

export async function listAssignments(
  classId: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<AssignmentDetails[]> {
  return (
    await pages(request, `/api/v1/classes/${encodeURIComponent(classId)}/assignments`, signal)
  ).map(assignmentDetails);
}

export async function readAssignment(
  classId: string,
  assignmentId: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<AssignmentDetails> {
  const value = assignmentDetails(
    await readJson(
      request,
      `/api/v1/classes/${encodeURIComponent(classId)}/assignments/${encodeURIComponent(assignmentId)}`,
      signal,
    ),
  );
  if (value.assignmentId !== assignmentId) throw new Error("The assignment is unavailable.");
  return value;
}
