import { assignmentSession } from "./assignment-api";
import { isId, isRecord } from "../home/workspace-api";
import { localDeadlineToUnixSeconds } from "./deadline";

export type PendingAssignmentEdit = {
  actorId: string;
  classId: string;
  assignmentId: string;
  body: {
    mutationId: string;
    expectedRevision: number;
    title: string;
    description: string;
    instructions: string;
    dueAtUnixSeconds: number;
    studentIds: string[];
  };
};
export type AssignmentEditResult =
  | { kind: "confirmed" | "unknown" }
  | { kind: "rejected"; message: string };
export const assignmentEditKey = (actorId: string, assignmentId: string) =>
  `spatia.assignment.edit:${actorId}:${assignmentId}`;

export function editDeadline(
  date: string,
  originalDate: string,
  originalDeadline: number,
): number | null {
  return date === originalDate ? originalDeadline : localDeadlineToUnixSeconds(date);
}

export function supersededAssignment(
  pending: PendingAssignmentEdit,
  current: { assignmentId: string; revision?: number },
): boolean {
  return (
    current.assignmentId === pending.assignmentId &&
    current.revision !== undefined &&
    current.revision > pending.body.expectedRevision
  );
}

export function readAssignmentEdit(
  storage: Storage,
  actorId: string,
  classId: string,
  assignmentId: string,
): PendingAssignmentEdit | null {
  const raw = storage.getItem(assignmentEditKey(actorId, assignmentId));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.actorId !== actorId ||
    value.classId !== classId ||
    value.assignmentId !== assignmentId ||
    !isId(value.actorId) ||
    !isId(value.classId) ||
    !isId(value.assignmentId) ||
    !isRecord(value.body) ||
    !isId(value.body.mutationId) ||
    !Number.isSafeInteger(value.body.expectedRevision) ||
    (value.body.expectedRevision as number) < 0 ||
    !Number.isSafeInteger(value.body.dueAtUnixSeconds) ||
    typeof value.body.title !== "string" ||
    !value.body.title.trim() ||
    typeof value.body.description !== "string" ||
    !value.body.description.trim() ||
    typeof value.body.instructions !== "string" ||
    !value.body.instructions.trim() ||
    !Array.isArray(value.body.studentIds) ||
    value.body.studentIds.length < 1 ||
    value.body.studentIds.length > 20 ||
    value.body.studentIds.some((id) => !isId(id)) ||
    new Set(value.body.studentIds).size !== value.body.studentIds.length
  )
    throw new Error("The earlier edit could not be verified.");
  return value as PendingAssignmentEdit;
}

export async function submitAssignmentEdit(
  pending: PendingAssignmentEdit,
  previouslyUncertain: boolean,
): Promise<AssignmentEditResult> {
  let sent = false;
  try {
    const session = await assignmentSession();
    if (session.userId !== pending.actorId || session.mustChangePassword)
      throw new Error("Account changed");
    const csrfResponse = await fetch("/api/v1/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Spatia-Account": pending.actorId },
      signal: AbortSignal.timeout(15000),
    });
    const csrf: unknown = csrfResponse.ok ? await csrfResponse.json() : null;
    if (!isRecord(csrf) || typeof csrf.requestToken !== "string" || !csrf.requestToken)
      throw new Error("Missing token");
    const current = await assignmentSession();
    if (current.userId !== pending.actorId || current.mustChangePassword)
      throw new Error("Account changed");
    sent = true;
    const response = await fetch(
      `/api/v1/classes/${encodeURIComponent(pending.classId)}/assignments/${encodeURIComponent(pending.assignmentId)}`,
      {
        method: "PATCH",
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
    if ([400, 409, 422].includes(response.status) && !previouslyUncertain)
      return {
        kind: "rejected",
        message:
          response.status === 409
            ? "The project or assignment changed. Refresh before editing again."
            : "The changes could not be saved. Check the details and students.",
      };
    if (response.status !== 200) return { kind: "unknown" };
    const result: unknown = await response.json();
    const after = await assignmentSession();
    if (
      after.userId !== pending.actorId ||
      after.mustChangePassword ||
      !isRecord(result) ||
      result.assignmentId !== pending.assignmentId ||
      result.revision !== pending.body.expectedRevision + 1
    )
      return { kind: "unknown" };
    return { kind: "confirmed" };
  } catch {
    return sent || previouslyUncertain
      ? { kind: "unknown" }
      : { kind: "rejected", message: "The changes could not be sent. Your edits are still here." };
  }
}
