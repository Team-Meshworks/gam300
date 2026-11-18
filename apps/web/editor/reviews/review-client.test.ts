import { describe, expect, it } from "vitest";
import { validateProjectStructure } from "../../shared/project/project-structure-validation";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
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
      const server = await serveHttp((request) => {
        const expected = request.headers.get("X-Spatia-Account");
        if (expected && expected !== active)
          return Response.json({ code: "account_changed" }, { status: 403 });
        if (new URL(request.url).pathname === "/api/v1/auth/csrf") {
          active = studentId;
          return Response.json({ requestToken: "replacement-token" });
        }
        decisions++;
        return Response.json(
          {
            submissionId,
            decisionId,
            sequence: 1,
            outcome: decide.outcome,
            feedback: decide.feedback,
            decidedAt: stamp,
          },
          { status: 201 },
        );
      });
      expect(await createReviewClient(server.fetch).execute(decide, educatorId)).toMatchObject({
        kind: "rejected",
        error: { code: "account_changed" },
      });
      expect(decisions).toBe(0);
      expect(server.requests[0]?.headers.get("X-Spatia-Account")).toBe(educatorId);
    },
  );
  it("uses CSRF, same-origin credentials and an exact saved revision", async () => {
    const server = await serveResponses(
      Response.json({ requestToken: "token" }),
      Response.json(ack, { status: 201 }),
    );
    expect(await createReviewClient(server.fetch).execute(submit, studentId)).toEqual({
      kind: "confirmed",
    });
    const mutation = server.requests[1];
    expect(mutation).toMatchObject({
      url: `${server.origin}/api/v1/projects/${projectId}/submissions`,
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(mutation?.headers.get("Content-Type")).toBe("application/json");
    expect(mutation?.headers.get("X-CSRF-TOKEN")).toBe("token");
    expect(mutation?.headers.get("X-Spatia-Account")).toBe(studentId);
    expect(await mutation?.json()).toEqual({
      submissionId,
      expectedRevision: 7,
      completionConfirmed: true,
    });
  });
  it("does not send a mutation when CSRF acquisition fails", async () => {
    const server = await serveResponses(Response.json({ code: "auth" }, { status: 401 }));
    expect((await createReviewClient(server.fetch).execute(submit, studentId)).kind).toBe(
      "rejected",
    );
    expect(server.requests.map((request) => request.url)).toEqual([
      `${server.origin}/api/v1/auth/csrf`,
    ]);
  });
  it("reports unavailable retained assets as a known rejection", async () => {
    const server = await serveResponses(
      Response.json({ requestToken: "token" }),
      Response.json({ code: "review_assets_unavailable" }, { status: 503 }),
    );
    expect(await createReviewClient(server.fetch).execute(submit, studentId)).toMatchObject({
      kind: "rejected",
      error: { code: "review_assets_unavailable" },
    });
  });
  it.each([500, 502, 503])("treats generic %s writes as uncertain", async (status) => {
    const server = await serveResponses(
      Response.json({ requestToken: "token" }),
      Response.json({}, { status }),
    );
    expect(await createReviewClient(server.fetch).execute(submit, studentId)).toEqual({
      kind: "unknown",
    });
  });
  it("reuses the same decision ID and feedback after a lost response", async () => {
    const server = await serveResponses(
      Response.json({ requestToken: "one" }),
      Response.error(),
      Response.json({ requestToken: "two" }),
      Response.json({
        submissionId,
        decisionId,
        sequence: 1,
        outcome: "returned",
        feedback: decide.feedback,
        decidedAt: stamp,
      }),
    );
    const client = createReviewClient(server.fetch);
    expect(await client.execute(decide, educatorId)).toEqual({ kind: "unknown" });
    expect(await client.execute(decide, educatorId)).toEqual({ kind: "confirmed" });
    expect(await server.requests[1]?.text()).toBe(await server.requests[3]?.text());
  });
  it.each([
    { ...ack, revision: 8 },
    { ...ack, projectId: studentId },
    { ...ack, submissionId: decisionId },
  ])("never accepts an acknowledgement for another revision or identity", async (badAck) => {
    const server = await serveResponses(
      Response.json({ requestToken: "token" }),
      Response.json(badAck),
    );
    expect(await createReviewClient(server.fetch).execute(submit, studentId)).toEqual({
      kind: "unknown",
    });
  });
  it("rejects HTML fallback and mismatched project content", async () => {
    const server = await serveResponses(
      new Response("<html/>", { headers: { "Content-Type": "text/html" } }),
      Response.json({ ...saved, document: { ...fixture, projectId: studentId } }),
    );
    const client = createReviewClient(server.fetch);
    await expect(client.project(projectId)).rejects.toThrow("invalid response");
    await expect(client.project(projectId)).rejects.toThrow("invalid response");
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
    const server = await serveResponses(
      Response.json({ ...review, nextCursor: educatorId }),
      Response.json({ ...review, decisions: [record] }),
    );
    expect(await createReviewClient(server.fetch).reconcile(decide)).toBe(true);
    expect(server.requests[1]?.url).toContain("cursor=" + educatorId);
    expect(server.requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  });
  it("does not interpret denied reconciliation as proof the original failed", async () => {
    const server = await serveResponses(
      Response.json({ code: "review_not_found" }, { status: 404 }),
    );
    await expect(createReviewClient(server.fetch).reconcile(submit)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("preserves the server's late flag and current-submission flag", async () => {
    const server = await serveResponses(
      Response.json({ ...review, isLate: true, isCurrentSubmission: false }),
    );
    expect(await createReviewClient(server.fetch).getReview(projectId, submissionId)).toMatchObject(
      {
        isLate: true,
        isCurrentSubmission: false,
      },
    );
  });
  it("pages all submissions and rejects repeating cursors", async () => {
    const server = await serveResponses(
      Response.json({ items: [review], nextCursor: submissionId }),
      Response.json({ items: [{ ...review, submissionId: decisionId }], nextCursor: null }),
      Response.json({ items: [], nextCursor: submissionId }),
      Response.json({ items: [], nextCursor: submissionId }),
    );
    const client = createReviewClient(server.fetch);
    const load = (cursor: string | null) => client.submissions(projectId, cursor);
    expect((await allPages(load)).map((item) => item.submissionId)).toEqual([
      submissionId,
      decisionId,
    ]);
    await expect(allPages(load)).rejects.toThrow("invalid response");
    expect(
      server.requests.map((request) => new URL(request.url).searchParams.get("cursor")),
    ).toEqual([null, submissionId, null, submissionId]);
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
