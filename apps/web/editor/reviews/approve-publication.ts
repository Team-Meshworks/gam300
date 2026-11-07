import { isId, isRecord, type WriteResult } from "../home/workspace-api";
import {
  publicationAcknowledgement,
  type PublicationAcknowledgement,
  type PublicationRequest,
} from "../publications/publication-client";
import type { ReviewClient } from "./review-client";

export type ApprovalPublicationIntent = {
  projectId: string;
  actorId: string;
  studentId: string;
  submissionId: string;
  decisionId: string;
  publicationId: string;
  revision: number;
  feedback: string;
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Publish = (
  actorId: string,
  path: string,
  method: "POST",
  body: object,
  problemMessages: Record<string, string>,
) => Promise<WriteResult>;
type Result =
  | { kind: "published"; acknowledgement: PublicationAcknowledgement }
  | { kind: "revision-conflict"; message: string }
  | { kind: "pending" | "rejected"; message: string };
const key = (actorId: string, projectId: string) =>
  `spatia-review-publication:${actorId}:${projectId}`;

export function readApprovalPublication(
  storage: Store,
  actorId: string,
  projectId: string,
  studentId: string,
): ApprovalPublicationIntent | null {
  const raw = storage.getItem(key(actorId, projectId));
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.actorId !== actorId ||
    value.projectId !== projectId ||
    value.studentId !== studentId ||
    !isId(value.actorId) ||
    !isId(value.projectId) ||
    !isId(value.studentId) ||
    !isId(value.submissionId) ||
    !isId(value.decisionId) ||
    !isId(value.publicationId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.feedback !== "string" ||
    !value.feedback.trim() ||
    value.feedback.length > 4000 ||
    value.feedback.includes("\0")
  )
    throw new Error("The earlier publishing request could not be verified.");
  return value as ApprovalPublicationIntent;
}

/** Preserve one exact approval and publication identity across uncertain responses */
export async function approveAndPublish(
  storage: Store,
  intent: ApprovalPublicationIntent,
  decide: ReviewClient["execute"],
  publish: Publish,
): Promise<Result> {
  const storageKey = key(intent.actorId, intent.projectId);
  let existing: ApprovalPublicationIntent | null;
  try {
    existing = readApprovalPublication(storage, intent.actorId, intent.projectId, intent.studentId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(intent))
      return {
        kind: "rejected",
        message: "Resolve the earlier publishing request before starting another.",
      };
    if (!existing) {
      const encoded = JSON.stringify(intent);
      storage.setItem(storageKey, encoded);
      if (storage.getItem(storageKey) !== encoded) throw new Error("Storage failed");
    }
  } catch {
    return {
      kind: "rejected",
      message:
        "The publishing request could not be safely saved or verified. Check any earlier request before continuing.",
    };
  }
  const decision = await decide(
    {
      kind: "decide",
      projectId: intent.projectId,
      submissionId: intent.submissionId,
      decisionId: intent.decisionId,
      expectedRevision: intent.revision,
      outcome: "approved",
      feedback: intent.feedback,
    },
    intent.actorId,
  );
  if (decision.kind !== "confirmed") {
    if (decision.kind === "rejected" && !existing) {
      try {
        storage.removeItem(storageKey);
      } catch {
        return {
          kind: "pending",
          message:
            "The approval was rejected, but the saved request could not be cleared. Retry the same request.",
        };
      }
      return { kind: "rejected", message: decision.error.message };
    }
    return {
      kind: "pending",
      message: "Approval could not be confirmed. Retry the same request before leaving.",
    };
  }
  const request: PublicationRequest = {
    publicationId: intent.publicationId,
    confirmedRevision: intent.revision,
    intent: { audience: "Unlisted", viewerIds: [] },
  };
  const result = await publish(
    intent.actorId,
    `/api/v1/projects/${encodeURIComponent(intent.projectId)}/publications`,
    "POST",
    request,
    { revision_conflict: "The saved project changed before it could be published." },
  );
  if (result.kind === "rejected" && result.code === "revision_conflict") {
    try {
      storage.removeItem(storageKey);
      if (storage.getItem(storageKey) !== null) throw new Error("Storage failed");
      return {
        kind: "revision-conflict",
        message:
          "Your review and approval were saved, but the project changed before publication. The student must submit the current work for a new review before it can be published.",
      };
    } catch {
      return {
        kind: "pending",
        message:
          "The project changed and was not published, but the saved request could not be cleared. Retry the same request.",
      };
    }
  }
  if (result.kind === "confirmed") {
    const acknowledgement = publicationAcknowledgement(result.value, intent.projectId, request);
    if (acknowledgement) {
      try {
        storage.removeItem(storageKey);
      } catch {
        /* The confirmed request remains safe to retry. */
      }
      return { kind: "published", acknowledgement };
    }
  }
  return {
    kind: "pending",
    message:
      result.kind === "rejected"
        ? `Approval was saved, but publication was not confirmed: ${result.message} Retry the same request.`
        : "Approval was saved, but publication could not be confirmed. Retry the same request.",
  };
}
