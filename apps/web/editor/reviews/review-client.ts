import { validateProjectStructure } from "../../shared/project/project-structure-validation";
import type {
  Assignment,
  Classroom,
  Decision,
  Outcome,
  Page,
  Review,
  ReviewIntent,
  SavedProject,
  Student,
  SubmissionSummary,
} from "./review-types";

export class ReviewError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = "unavailable") {
    super(message);
    this.name = "ReviewError";
    this.status = status;
    this.code = code;
  }
}
const invalid = () =>
  new ReviewError("The service returned an invalid response. Refresh before continuing.");
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const string = (v: unknown): string => {
  if (typeof v !== "string") throw invalid();
  return v;
};
const id = (v: unknown): string => {
  const s = string(v);
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s)
  )
    throw invalid();
  return s.toLowerCase();
};
const integer = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw invalid();
  return v;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== "boolean") throw invalid();
  return v;
};
const date = (v: unknown): string => {
  const s = string(v);
  if (!Number.isFinite(Date.parse(s))) throw invalid();
  return s;
};
const cursor = (v: unknown) => (v === null ? null : id(v));
const array = <T>(v: unknown, parse: (v: unknown) => T): T[] => {
  if (!Array.isArray(v)) throw invalid();
  return v.map(parse);
};
function document(v: unknown, projectId: string) {
  const checked = validateProjectStructure(v);
  if (!checked.ok || checked.value.projectId.toLowerCase() !== projectId) throw invalid();
  return checked.value;
}
function page<T>(v: unknown, parse: (v: unknown) => T): Page<T> {
  const r = record(v);
  return { items: array(r.items, parse), nextCursor: cursor(r.nextCursor) };
}
function summary(v: unknown): SubmissionSummary {
  const r = record(v);
  return {
    submissionId: id(r.submissionId),
    revision: integer(r.revision),
    sequence: integer(r.sequence),
    submittedAt: date(r.submittedAt),
    dueAtUnixSeconds: integer(r.dueAtUnixSeconds),
    isLate: bool(r.isLate),
    isCurrentSubmission: bool(r.isCurrentSubmission),
  };
}
function outcome(v: unknown): Outcome {
  if (v !== "approved" && v !== "returned" && v !== "revoked") throw invalid();
  return v;
}
function decision(v: unknown): Decision {
  const r = record(v);
  return {
    id: id(r.id),
    educatorId: id(r.educatorId),
    sequence: integer(r.sequence),
    outcome: outcome(r.outcome),
    feedback: string(r.feedback),
    decidedAt: date(r.decidedAt),
  };
}
function review(v: unknown, projectId: string, submissionId: string): Review {
  const r = record(v);
  const s = summary(r);
  if (id(r.projectId) !== projectId || s.submissionId !== submissionId) throw invalid();
  return {
    ...s,
    projectId,
    studentId: id(r.studentId),
    document: document(r.document, projectId),
    assetReferences: array(r.assetReferences, (item) => {
      const a = record(item);
      const sha256 = string(a.sha256);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalid();
      return { assetId: string(a.assetId), sha256 };
    }),
    latestDecision: r.latestDecision === null ? null : decision(r.latestDecision),
    decisions: array(r.decisions, decision),
    nextCursor: cursor(r.nextCursor),
  };
}
const problemMessages: Record<string, string> = {
  review_assets_unavailable:
    "Submission is unavailable because the project's assets are not ready for review. Your saved project is unchanged.",
  review_decision_conflict:
    "This submission or decision has changed. Refresh its status before deciding again. Your feedback is preserved.",
  submission_conflict:
    "This submission could not be reconciled. Refresh its status before continuing.",
  revision_conflict:
    "A newer project revision exists. Refresh and review that revision before continuing.",
  invalid_review_decision: "Check the decision and feedback, then try again.",
  invalid_submission_input: "Confirm completion of the saved revision before submitting.",
};
export type WriteResult =
  { kind: "confirmed" } | { kind: "rejected"; error: ReviewError } | { kind: "unknown" };

export function createReviewClient(request: typeof fetch = fetch) {
  async function send(path: string, init: RequestInit = {}) {
    return request(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  }
  async function read(response: Response): Promise<unknown> {
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const code = data && typeof data.code === "string" ? data.code : "unavailable";
      const message =
        problemMessages[code] ??
        (response.status === 401
          ? "Your session has expired. Sign in again to continue."
          : response.status === 403
            ? "You no longer have permission for this action, or your password must be changed."
            : response.status === 404
              ? "This project or submission is unavailable to your account."
              : response.status === 409
                ? "The saved revision or access has changed. Refresh before continuing."
                : response.status === 429
                  ? "Too many requests. Wait a moment before trying again."
                  : "The review service is unavailable. Try again later.");
      throw new ReviewError(message, response.status, code);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) throw invalid();
    return response.json().catch(() => {
      throw invalid();
    });
  }
  async function get(path: string) {
    try {
      return await read(await send(path));
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("The review service could not be reached. Try again.");
    }
  }
  function paged(path: string, after?: string | null) {
    return path + "?limit=20" + (after ? "&cursor=" + id(after) : "");
  }
  const projectPath = (projectId: string) => "/api/projects/" + id(projectId);
  const submissionsPath = (projectId: string) => projectPath(projectId) + "/submissions";
  async function getReview(projectId: string, submissionId: string, after?: string | null) {
    return review(
      await get(paged(submissionsPath(projectId) + "/" + id(submissionId), after)),
      id(projectId),
      id(submissionId),
    );
  }
  async function execute(intent: ReviewIntent): Promise<WriteResult> {
    let token: string;
    try {
      token = string(record(await get("/api/auth/csrf")).requestToken);
      if (!token) throw invalid();
    } catch (error) {
      return { kind: "rejected", error: error instanceof ReviewError ? error : invalid() };
    }
    const path =
      submissionsPath(intent.projectId) +
      (intent.kind === "decide" ? "/" + id(intent.submissionId) + "/decisions" : "");
    const body =
      intent.kind === "submit"
        ? {
            submissionId: intent.submissionId,
            expectedRevision: intent.expectedRevision,
            completionConfirmed: true,
          }
        : {
            decisionId: intent.decisionId,
            expectedRevision: intent.expectedRevision,
            outcome: intent.outcome,
            feedback: intent.feedback,
          };
    let response: Response;
    try {
      response = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token },
        body: JSON.stringify(body),
      });
    } catch {
      return { kind: "unknown" };
    }
    // A server failure or unreadable acknowledgement may follow a committed write.
    if (response.status >= 500) {
      // This exact server code is emitted before submission evidence is written.
      if (intent.kind === "submit" && response.status === 503) {
        const problem = await response
          .clone()
          .json()
          .catch(() => null);
        if (problem?.code === "review_assets_unavailable")
          return {
            kind: "rejected",
            error: new ReviewError(problemMessages.review_assets_unavailable!, 503, problem.code),
          };
      }
      return { kind: "unknown" };
    }
    if (!response.ok) {
      try {
        await read(response);
      } catch (error) {
        return { kind: "rejected", error: error instanceof ReviewError ? error : invalid() };
      }
    }
    try {
      if (response.status !== 200 && response.status !== 201) return { kind: "unknown" };
      const ack = record(await read(response));
      if (id(ack.submissionId) !== id(intent.submissionId)) return { kind: "unknown" };
      if (intent.kind === "submit") {
        if (
          id(ack.projectId) !== id(intent.projectId) ||
          integer(ack.revision) !== intent.expectedRevision
        )
          return { kind: "unknown" };
        date(ack.submittedAt);
        integer(ack.dueAtUnixSeconds);
        bool(ack.isLate);
      } else {
        if (
          id(ack.decisionId) !== id(intent.decisionId) ||
          outcome(ack.outcome) !== intent.outcome ||
          string(ack.feedback) !== intent.feedback
        )
          return { kind: "unknown" };
        integer(ack.sequence);
        date(ack.decidedAt);
      }
      return { kind: "confirmed" };
    } catch {
      return { kind: "unknown" };
    }
  }
  async function reconcile(intent: ReviewIntent): Promise<boolean> {
    let after: string | null = null;
    const seen = new Set<string>();
    do {
      const found = await getReview(intent.projectId, intent.submissionId, after);
      if (found.revision !== intent.expectedRevision) throw invalid();
      if (intent.kind === "submit") return true;
      const matched = [found.latestDecision, ...found.decisions].find(
        (d) => d?.id === intent.decisionId,
      );
      if (matched) {
        if (matched.outcome !== intent.outcome || matched.feedback !== intent.feedback)
          throw invalid();
        return true;
      }
      after = found.nextCursor;
      if (after && seen.has(after)) throw invalid();
      if (after) seen.add(after);
    } while (after);
    return false;
  }
  return {
    execute,
    reconcile,
    getReview,
    async classrooms(after?: string | null) {
      return page(await get(paged("/api/classes", after)), (v) => {
        const r = record(v);
        return { id: id(r.id), name: string(r.name) } satisfies Classroom;
      });
    },
    async assignments(classId: string, after?: string | null) {
      return page(await get(paged("/api/classes/" + id(classId) + "/assignments", after)), (v) => {
        const r = record(v);
        return {
          assignmentId: id(r.assignmentId),
          title: string(r.title),
          dueAtUnixSeconds: integer(r.dueAtUnixSeconds),
          projects: array(r.projects, (p) => {
            const row = record(p);
            return { studentId: id(row.studentId), projectId: id(row.projectId) };
          }),
        } satisfies Assignment;
      });
    },
    async roster(classId: string, after?: string | null) {
      return page(await get(paged("/api/classes/" + id(classId) + "/roster", after)), (v) => {
        const r = record(v);
        return {
          userId: id(r.userId),
          userName: string(r.userName),
          accountActive: bool(r.accountActive),
        } satisfies Student;
      });
    },
    async project(projectId: string): Promise<SavedProject> {
      const r = record(await get(projectPath(projectId)));
      if (id(r.projectId) !== id(projectId)) throw invalid();
      const p = record(r.permissions);
      return {
        projectId: id(r.projectId),
        revision: integer(r.revision),
        document: document(r.document, id(projectId)),
        permissions: {
          canEdit: bool(p.canEdit),
          canManage: bool(p.canManage),
          canPublish: bool(p.canPublish),
        },
      };
    },
    async submissions(projectId: string, after?: string | null) {
      return page(await get(paged(submissionsPath(projectId), after)), summary);
    },
  };
}
export type ReviewClient = ReturnType<typeof createReviewClient>;

// Used for bounded server pages; reject broken cursors rather than silently dropping records.
export async function allPages<T>(load: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  do {
    const result = await load(after);
    items.push(...result.items);
    after = result.nextCursor;
    if (after && seen.has(after)) throw invalid();
    if (after) seen.add(after);
  } while (after);
  return items;
}
