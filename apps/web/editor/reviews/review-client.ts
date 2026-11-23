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
const record = (v: unknown): object => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid();
  return v;
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
  if (!("items" in r) || !("nextCursor" in r)) throw invalid();
  return { items: array(r.items, parse), nextCursor: cursor(r.nextCursor) };
}
function summary(v: unknown): SubmissionSummary {
  const r = record(v);
  if (
    !("submissionId" in r) ||
    !("revision" in r) ||
    !("sequence" in r) ||
    !("submittedAt" in r) ||
    !("dueAtUnixSeconds" in r) ||
    !("isLate" in r) ||
    !("isCurrentSubmission" in r)
  )
    throw invalid();
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
  if (
    !("id" in r) ||
    !("educatorId" in r) ||
    !("sequence" in r) ||
    !("outcome" in r) ||
    !("feedback" in r) ||
    !("decidedAt" in r)
  )
    throw invalid();
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
  if (
    !("projectId" in r) ||
    id(r.projectId) !== projectId ||
    s.submissionId !== submissionId ||
    !("studentId" in r) ||
    !("document" in r) ||
    !("assetReferences" in r) ||
    !("latestDecision" in r) ||
    !("decisions" in r) ||
    !("nextCursor" in r)
  )
    throw invalid();
  return {
    ...s,
    projectId,
    studentId: id(r.studentId),
    document: document(r.document, projectId),
    assetReferences: array(r.assetReferences, (item) => {
      const a = record(item);
      if (!("assetId" in a) || !("sha256" in a)) throw invalid();
      const sha256 = string(a.sha256);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalid();
      return { assetId: string(a.assetId), sha256 };
    }),
    latestDecision: r.latestDecision === null ? null : decision(r.latestDecision),
    decisions: array(r.decisions, decision),
    nextCursor: cursor(r.nextCursor),
  };
}
const problemMessages = {
  account_changed: "The account changed. Reload before continuing. Your feedback is preserved.",
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
function isReviewProblem(code: string): code is keyof typeof problemMessages {
  return Object.hasOwn(problemMessages, code);
}
export type WriteResult =
  | { kind: "confirmed" }
  | { kind: "rejected"; error: ReviewError }
  | { kind: "unknown" };

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
      const data: unknown = await response.json().catch(() => null);
      const code =
        data && typeof data === "object" && "code" in data && typeof data.code === "string"
          ? data.code
          : "unavailable";
      const message = isReviewProblem(code)
        ? problemMessages[code]
        : response.status === 401
          ? "Your session has expired. Sign in again to continue."
          : response.status === 403
            ? "You no longer have permission for this action, or your password must be changed."
            : response.status === 404
              ? "This project or submission is unavailable to your account."
              : response.status === 409
                ? "The saved revision or access has changed. Refresh before continuing."
                : response.status === 429
                  ? "Too many requests. Wait a moment before trying again."
                  : "The review service is unavailable. Try again later.";
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
  const projectPath = (projectId: string) => "/api/v1/projects/" + id(projectId);
  const submissionsPath = (projectId: string) => projectPath(projectId) + "/submissions";
  async function getReview(projectId: string, submissionId: string, after?: string | null) {
    return review(
      await get(paged(submissionsPath(projectId) + "/" + id(submissionId), after)),
      id(projectId),
      id(submissionId),
    );
  }
  async function execute(intent: ReviewIntent, actorId: string): Promise<WriteResult> {
    let token: string;
    try {
      const csrf = record(
        await read(
          await send("/api/v1/auth/csrf", { headers: { "X-Spatia-Account": id(actorId) } }),
        ),
      );
      if (!("requestToken" in csrf)) throw invalid();
      token = string(csrf.requestToken);
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
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": token,
          "X-Spatia-Account": id(actorId),
        },
        body: JSON.stringify(body),
      });
    } catch {
      return { kind: "unknown" };
    }
    // A server failure or unreadable acknowledgement may follow a committed write.
    if (response.status >= 500) {
      // This exact server code is emitted before submission evidence is written.
      if (intent.kind === "submit" && response.status === 503) {
        const problem: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        if (
          problem &&
          typeof problem === "object" &&
          "code" in problem &&
          problem.code === "review_assets_unavailable"
        )
          return {
            kind: "rejected",
            error: new ReviewError(problemMessages.review_assets_unavailable, 503, problem.code),
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
      if (!("submissionId" in ack) || id(ack.submissionId) !== id(intent.submissionId))
        return { kind: "unknown" };
      if (intent.kind === "submit") {
        if (
          !("projectId" in ack) ||
          id(ack.projectId) !== id(intent.projectId) ||
          !("revision" in ack) ||
          integer(ack.revision) !== intent.expectedRevision ||
          !("submittedAt" in ack) ||
          !("dueAtUnixSeconds" in ack) ||
          !("isLate" in ack)
        )
          return { kind: "unknown" };
        date(ack.submittedAt);
        integer(ack.dueAtUnixSeconds);
        bool(ack.isLate);
      } else {
        if (
          !("decisionId" in ack) ||
          id(ack.decisionId) !== id(intent.decisionId) ||
          !("outcome" in ack) ||
          outcome(ack.outcome) !== intent.outcome ||
          !("feedback" in ack) ||
          string(ack.feedback) !== intent.feedback ||
          !("sequence" in ack) ||
          !("decidedAt" in ack)
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
    async projectAssignment(projectId: string) {
      const row = record(await get(submissionsPath(projectId) + "?limit=1"));
      if (!("projectId" in row) || !("classId" in row) || !("assignmentId" in row)) throw invalid();
      const linkedProjectId = id(row.projectId);
      if (linkedProjectId !== id(projectId)) throw invalid();
      return {
        projectId: linkedProjectId,
        classId: id(row.classId),
        assignmentId: id(row.assignmentId),
      };
    },
    async classrooms(after?: string | null) {
      return page(await get(paged("/api/v1/classes", after)), (v) => {
        const r = record(v);
        if (!("id" in r) || !("name" in r)) throw invalid();
        return { id: id(r.id), name: string(r.name) } satisfies Classroom;
      });
    },
    async assignments(classId: string, after?: string | null) {
      return page(
        await get(paged("/api/v1/classes/" + id(classId) + "/assignments", after)),
        (v) => {
          const r = record(v);
          if (
            !("assignmentId" in r) ||
            !("title" in r) ||
            !("dueAtUnixSeconds" in r) ||
            !("projects" in r)
          )
            throw invalid();
          return {
            assignmentId: id(r.assignmentId),
            title: string(r.title),
            dueAtUnixSeconds: integer(r.dueAtUnixSeconds),
            projects: array(r.projects, (p) => {
              const row = record(p);
              if (!("studentId" in row) || !("projectId" in row)) throw invalid();
              return { studentId: id(row.studentId), projectId: id(row.projectId) };
            }),
          } satisfies Assignment;
        },
      );
    },
    async roster(classId: string, after?: string | null) {
      return page(await get(paged("/api/v1/classes/" + id(classId) + "/roster", after)), (v) => {
        const r = record(v);
        if (!("userId" in r) || !("userName" in r) || !("accountActive" in r)) throw invalid();
        return {
          userId: id(r.userId),
          userName: string(r.userName),
          accountActive: bool(r.accountActive),
        } satisfies Student;
      });
    },
    async project(projectId: string): Promise<SavedProject> {
      const r = record(await get(projectPath(projectId)));
      if (
        !("projectId" in r) ||
        id(r.projectId) !== id(projectId) ||
        !("revision" in r) ||
        !("document" in r) ||
        !("permissions" in r)
      )
        throw invalid();
      const p = record(r.permissions);
      if (!("canEdit" in p) || !("canManage" in p) || !("canPublish" in p)) throw invalid();
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
