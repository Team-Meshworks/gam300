import { expect, it, vi } from "vitest";
import { loadStudentFeedback } from "./student-feedback";

it("collects dated feedback from every submission without duplicating decisions", async () => {
  const decision = (id: string, sequence: number) => ({
    id,
    educatorId: "teacher",
    sequence,
    outcome: "returned" as const,
    feedback: `Comment ${id}`,
    decidedAt: "2026-11-05T00:00:00Z",
  });
  const client = {
    submissions: vi.fn(async () => ({
      items: [{ submissionId: "one" }, { submissionId: "two" }],
      nextCursor: null,
    })),
    getReview: vi.fn(async (_project: string, submission: string, cursor?: string | null) =>
      submission === "one"
        ? { studentId: "alice", decisions: [decision("a", 1)], nextCursor: null }
        : cursor
          ? { studentId: "alice", decisions: [decision("b", 2)], nextCursor: null }
          : { studentId: "alice", decisions: [decision("b", 2)], nextCursor: "next" },
    ),
  };
  const result = await loadStudentFeedback(client, "project", "alice");
  expect(result.map((item) => item.feedback)).toEqual(["Comment b", "Comment a"]);
  expect(client.getReview).toHaveBeenCalledTimes(3);
});

it("rejects feedback returned for a different student", async () => {
  const client = {
    submissions: vi.fn(async () => ({ items: [{ submissionId: "one" }], nextCursor: null })),
    getReview: vi.fn(async () => ({ studentId: "other", decisions: [], nextCursor: null })),
  };
  await expect(loadStudentFeedback(client, "project", "alice")).rejects.toThrow();
});
