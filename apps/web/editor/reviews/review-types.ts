import type { ProjectDocument } from "../../shared/project/project-types";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Classroom {
  id: string;
  name: string;
}
export interface Assignment {
  assignmentId: string;
  title: string;
  dueAtUnixSeconds: number;
  projects: { studentId: string; projectId: string }[];
}
export interface Student {
  userId: string;
  userName: string;
  accountActive: boolean;
}
export interface SavedProject {
  projectId: string;
  revision: number;
  document: ProjectDocument;
  permissions: { canEdit: boolean; canManage: boolean; canPublish: boolean };
}
export type Outcome = "approved" | "returned" | "revoked";
export interface SubmissionSummary {
  submissionId: string;
  revision: number;
  sequence: number;
  submittedAt: string;
  dueAtUnixSeconds: number;
  isLate: boolean;
  isCurrentSubmission: boolean;
}
export interface Decision {
  id: string;
  educatorId: string;
  sequence: number;
  outcome: Outcome;
  feedback: string;
  decidedAt: string;
}
export interface Review extends SubmissionSummary {
  projectId: string;
  studentId: string;
  document: ProjectDocument;
  assetReferences: { assetId: string; sha256: string }[];
  latestDecision: Decision | null;
  decisions: Decision[];
  nextCursor: string | null;
}
export type ReviewIntent =
  | {
      kind: "submit";
      projectId: string;
      submissionId: string;
      expectedRevision: number;
      completionConfirmed: true;
    }
  | {
      kind: "decide";
      projectId: string;
      submissionId: string;
      decisionId: string;
      expectedRevision: number;
      outcome: Outcome;
      feedback: string;
    };

export function reviewState(review: Review, revision: number) {
  if (!review.isCurrentSubmission || review.revision !== revision) return "historical";
  return review.latestDecision?.outcome ?? "pending";
}
export function mayDecide(review: Review, project: SavedProject, outcome: Outcome) {
  if (!project.permissions.canManage) return false;
  const state = reviewState(review, project.revision);
  return outcome === "revoked" ? state === "approved" : state === "pending";
}
