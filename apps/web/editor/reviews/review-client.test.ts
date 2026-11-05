import { describe, expect, it, vi } from "vitest";
import { validateProjectStructure } from "../../shared/project/project-structure-validation";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { allPages, createReviewClient } from "./review-client";
import {
  mayDecide,
  reviewState,
  type Review,
  type ReviewIntent,
  type SavedProject,
} from "./review-types";

const checked = validateProjectStructure(fixture);
if (!checked.ok) throw new Error(checked.error.message);
const projectId = fixture.projectId;
const studentId = "11111111-1111-4111-8111-111111111111";
const submissionId = "22222222-2222-4222-8222-222222222222";
const decisionId = "33333333-3333-4333-8333-333333333333";
const educatorId = "44444444-4444-4444-8444-444444444444";
const stamp = "2026-11-02T01:00:00Z";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const submit: ReviewIntent = {
  kind: "submit",
  projectId,
  submissionId,
  expectedRevision: 7,
  completionConfirmed: true,
};
const decide: ReviewIntent = {
  kind: "decide",
  projectId,
  submissionId,
  decisionId,
  expectedRevision: 7,
  outcome: "returned",
  feedback: "Please revise the layout.",
};
const review: Review = {
  submissionId,
  projectId,
  studentId,
  revision: 7,
  sequence: 2,
  submittedAt: stamp,
  dueAtUnixSeconds: 1793581200,
  isLate: false,
  isCurrentSubmission: true,
  document: checked.value,
  assetReferences: [],
  latestDecision: null,
  decisions: [],
  nextCursor: null,
};
const saved: SavedProject = {
  projectId,
  revision: 7,
  document: review.document,
  permissions: { canEdit: true, canManage: true, canPublish: true },
};
const ack = {
  submissionId,
  projectId,
  revision: 7,
  submittedAt: stamp,
  dueAtUnixSeconds: 1793581200,
  isLate: true,
};

describe("review HTTP contract", () => {
  it.each(["before token", "after token"])(
    "rejects an account switch %s without writing as the replacement account",
    async (timing) => {
      let active = timing === "before token" ? studentId : educatorId;
      let decisions = 0;
      const request = vi.fn<typeof fetch>(async (path, init) => {
        const expected = new Headers(init?.headers).get("X-Spatia-Account");
        if (expected && expected !== active) return json({ code: "account_changed" }, 403);
        if (path === "/api/auth/csrf") {
          active = studentId;
          return json({ requestToken: "replacement-token" });
        }
        decisions++;
        return json(
          {
            submissionId,
            decisionId,
            sequence: 1,
            outcome: decide.outcome,
            feedback: decide.feedback,
            decidedAt: stamp,
          },
          201,
        );
      });
      expect(await createReviewClient(request).execute(decide, educatorId)).toMatchObject({
        kind: "rejected",
        error: { code: "account_changed" },
      });
      expect(decisions).toBe(0);
      expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("X-Spatia-Account")).toBe(
        educatorId,
      );
    },
  );
  it("uses CSRF, same-origin credentials and an exact saved revision", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json(ack, 201));
    expect(await createReviewClient(request).execute(submit, studentId)).toEqual({
      kind: "confirmed",
    });
    expect(request.mock.calls[1]).toEqual([
      "/api/projects/" + projectId + "/submissions",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": "token",
          "X-Spatia-Account": studentId,
        },
        body: JSON.stringify({ submissionId, expectedRevision: 7, completionConfirmed: true }),
      }),
    ]);
  });
  it("does not send a mutation when CSRF acquisition fails", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ code: "auth" }, 401));
    expect((await createReviewClient(request).execute(submit, studentId)).kind).toBe("rejected");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable retained assets as a known rejection", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json({ code: "review_assets_unavailable" }, 503));
    expect(await createReviewClient(request).execute(submit, studentId)).toMatchObject({
      kind: "rejected",
      error: { code: "review_assets_unavailable" },
    });
  });
  it.each([500, 502, 503])("treats generic %s writes as uncertain", async (status) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json({}, status));
    expect(await createReviewClient(request).execute(submit, studentId)).toEqual({
      kind: "unknown",
    });
  });
  it("reuses the same decision ID and feedback after a lost response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "one" }))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(json({ requestToken: "two" }))
      .mockResolvedValueOnce(
        json(
          {
            submissionId,
            decisionId,
            sequence: 1,
            outcome: "returned",
            feedback: decide.feedback,
            decidedAt: stamp,
          },
          200,
        ),
      );
    const client = createReviewClient(request);
    expect(await client.execute(decide, educatorId)).toEqual({ kind: "unknown" });
    expect(await client.execute(decide, educatorId)).toEqual({ kind: "confirmed" });
    expect(request.mock.calls[1]?.[1]?.body).toEqual(request.mock.calls[3]?.[1]?.body);
  });
  it.each([
    { ...ack, revision: 8 },
    { ...ack, projectId: studentId },
    { ...ack, submissionId: decisionId },
  ])("never accepts an acknowledgement for another revision or identity", async (badAck) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json(badAck));
    expect(await createReviewClient(request).execute(submit, studentId)).toEqual({
      kind: "unknown",
    });
  });
  it("rejects HTML fallback and mismatched project content", async () => {
    await expect(
      createReviewClient(vi.fn<typeof fetch>().mockResolvedValue(new Response("<html/>"))).project(
        projectId,
      ),
    ).rejects.toThrow("invalid response");
    await expect(
      createReviewClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ ...saved, document: { ...fixture, projectId: studentId } })),
      ).project(projectId),
    ).rejects.toThrow("invalid response");
  });
  it("reconciles a decision from a later history page without posting again", async () => {
    const record = {
      id: decisionId,
      educatorId,
      sequence: 1,
      outcome: "returned",
      feedback: decide.feedback,
      decidedAt: stamp,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...review, nextCursor: educatorId }))
      .mockResolvedValueOnce(json({ ...review, decisions: [record] }));
    expect(await createReviewClient(request).reconcile(decide)).toBe(true);
    expect(request.mock.calls[1]?.[0]).toContain("cursor=" + educatorId);
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("does not interpret denied reconciliation as proof the original failed", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ code: "review_not_found" }, 404));
    await expect(createReviewClient(request).reconcile(submit)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("preserves the server's late flag and current-submission flag", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ...review, isLate: true, isCurrentSubmission: false }));
    expect(await createReviewClient(request).getReview(projectId, submissionId)).toMatchObject({
      isLate: true,
      isCurrentSubmission: false,
    });
  });
  it("pages all submissions and rejects repeating cursors", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], nextCursor: submissionId })
      .mockResolvedValueOnce({ items: [2], nextCursor: null });
    expect(await allPages(load)).toEqual([1, 2]);
    await expect(allPages(async () => ({ items: [], nextCursor: submissionId }))).rejects.toThrow(
      "invalid response",
    );
  });
});
describe("review authority and revision mapping", () => {
  const approval = {
    id: decisionId,
    educatorId,
    sequence: 1,
    outcome: "approved" as const,
    feedback: "Approved",
    decidedAt: stamp,
  };
  it("never carries old approval to a newer revision or submission", () => {
    expect(reviewState({ ...review, latestDecision: approval }, 8)).toBe("historical");
    expect(
      reviewState({ ...review, latestDecision: approval, isCurrentSubmission: false }, 7),
    ).toBe("historical");
    expect(mayDecide(review, { ...saved, revision: 8 }, "approved")).toBe(false);
  });
  it("requires manage permission and a new submission after return or revocation", () => {
    expect(
      mayDecide(
        review,
        { ...saved, permissions: { ...saved.permissions, canManage: false } },
        "approved",
      ),
    ).toBe(false);
    for (const outcome of ["returned", "revoked"] as const)
      expect(
        mayDecide({ ...review, latestDecision: { ...approval, outcome } }, saved, "approved"),
      ).toBe(false);
    expect(mayDecide({ ...review, latestDecision: approval }, saved, "revoked")).toBe(true);
    expect(mayDecide(review, saved, "revoked")).toBe(false);
  });
});
