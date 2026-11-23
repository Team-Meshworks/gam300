import { expect, it } from "vitest";
import document from "../../shared/project/fixtures/m1-project.json";
import { serveResponses } from "../../tests/http-fixture";
import { createReviewClient } from "../reviews/review-client";
import { loadStudentFeedback } from "./student-feedback";

const student = "11111111-1111-4111-8111-111111111111";
const educatorId = "22222222-2222-4222-8222-222222222222";
const cursor = "33333333-3333-4333-8333-333333333333";
const [first, second] = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
].map((submissionId, index) => ({
  submissionId,
  revision: index + 1,
  sequence: index + 1,
  submittedAt: "2026-11-04T00:00:00Z",
  dueAtUnixSeconds: 2_000_000_000,
  isLate: false,
  isCurrentSubmission: index === 1,
}));
function review(
  submission: typeof first,
  studentId: string,
  decisions: object[],
  nextCursor: string | null = null,
) {
  return Response.json({
    ...submission,
    document,
    assetReferences: [],
    latestDecision: decisions.at(-1) ?? null,
    projectId: document.projectId,
    studentId,
    decisions,
    nextCursor,
  });
}

it("collects dated feedback from every submission without duplicating decisions", async () => {
  const decision = (id: string, sequence: number, feedback: string) => ({
    id,
    educatorId,
    sequence,
    outcome: "returned",
    feedback,
    decidedAt: "2026-11-05T00:00:00Z",
  });
  const a = decision(first!.submissionId, 1, "Comment a");
  const b = decision(second!.submissionId, 2, "Comment b");
  const server = await serveResponses(
    Response.json({ items: [first, second], nextCursor: null }),
    review(first, student, [a]),
    review(second, student, [b], cursor),
    review(second, student, [b]),
  );
  const result = await loadStudentFeedback(
    createReviewClient(server.fetch),
    document.projectId,
    student,
  );
  expect(result.map((item) => item.feedback)).toEqual(["Comment b", "Comment a"]);
  expect(server.requests).toHaveLength(4);
  expect(new URL(server.requests[3]!.url).searchParams.get("cursor")).toBe(cursor);
});

it("rejects feedback returned for a different student", async () => {
  const server = await serveResponses(
    Response.json({ items: [first], nextCursor: null }),
    review(first, educatorId, []),
  );
  await expect(
    loadStudentFeedback(createReviewClient(server.fetch), document.projectId, student),
  ).rejects.toThrow("Student mismatch");
});
