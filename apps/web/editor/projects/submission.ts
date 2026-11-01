// UI adapter types, not an HTTP contract. Hosts must supply authorized snapshots
export type SubmissionState = "editing" | "completed" | "submitted" | "approved";
export type SubmissionAction = "complete" | "submit" | "save-review" | "approve";
export type Audience = "student" | "teacher";
export interface Submission {
  id: string;
  revision: number;
  title: string;
  student: string;
  className: string;
  state: SubmissionState;
}
export interface SubmissionDraft {
  id: string;
  revision: number;
  action: SubmissionAction;
  feedback: string;
}
export type SubmissionResult =
  | { kind: "confirmed"; submission: Submission }
  | { kind: "rejected"; message: string }
  | { kind: "unknown" };
export function canAct(item: Submission, action: SubmissionAction, audience: Audience) {
  if (audience === "student")
    return (
      (action === "complete" && item.state === "editing") ||
      (action === "submit" && item.state === "completed")
    );
  return item.state === "submitted" && (action === "save-review" || action === "approve");
}
export function confirmsAction(draft: SubmissionDraft, item: Submission) {
  const expected: Record<SubmissionAction, SubmissionState> = {
    complete: "completed",
    submit: "submitted",
    "save-review": "submitted",
    approve: "approved",
  };
  return (
    item.id === draft.id &&
    item.revision === draft.revision &&
    item.state === expected[draft.action]
  );
}
