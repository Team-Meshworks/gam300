import { allPages } from "../reviews/review-client";
import type { Decision, Page } from "../reviews/review-types";

type FeedbackClient = {
  submissions: (
    projectId: string,
    cursor?: string | null,
  ) => Promise<Page<{ submissionId: string }>>;
  getReview: (
    projectId: string,
    submissionId: string,
    cursor?: string | null,
  ) => Promise<{ studentId: string; decisions: Decision[]; nextCursor: string | null }>;
};

export async function loadStudentFeedback(
  client: FeedbackClient,
  projectId: string,
  studentId: string,
): Promise<Decision[]> {
  const submissions = await allPages((cursor) => client.submissions(projectId, cursor));
  const decisions = new Map<string, Decision>();
  for (const submission of submissions) {
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.getReview(projectId, submission.submissionId, cursor);
      if (page.studentId !== studentId) throw new Error("Student mismatch");
      for (const decision of page.decisions)
        if (decision.feedback.trim()) decisions.set(decision.id, decision);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Invalid cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return [...decisions.values()].sort(
    (a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.sequence - a.sequence,
  );
}
