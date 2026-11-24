import { describe, expect, it } from "vitest";
import { serveResponses } from "../../tests/http-fixture";
import { createProgressReviewClient } from "./progress-review-client";

const projectId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const reviewId = "33333333-3333-4333-8333-333333333333";
const item = {
  id: reviewId,
  feedback: "Keep going",
  revision: 2,
  createdAt: "2026-10-20T00:00:00Z",
};
describe("progress review client", () => {
  it("reads dated feedback and follows the project-scoped cursor", async () => {
    const server = await serveResponses(
      Response.json({ items: [item], nextCursor: reviewId }),
      Response.json({ userId: actorId, role: "Creator", mustChangePassword: false }),
    );
    expect(
      await createProgressReviewClient(server.fetch).list(projectId, actorId, "Creator", reviewId),
    ).toEqual({
      items: [item],
      nextCursor: reviewId,
    });
    expect(server.requests[0]?.url).toBe(
      `${server.origin}/api/v1/projects/${projectId}/progress-reviews?limit=20&cursor=${reviewId}`,
    );
    expect(server.requests[0]?.headers.get("X-Spatia-Account")).toBe(actorId);
  });
  it("does not return private feedback when the account changes during the read", async () => {
    const server = await serveResponses(
      Response.json({ items: [item], nextCursor: null }),
      Response.json({ userId: projectId, role: "Creator", mustChangePassword: false }),
    );
    await expect(
      createProgressReviewClient(server.fetch).list(projectId, actorId, "Creator"),
    ).rejects.toThrow("account changed");
  });
  it("keeps the same id and input when a write outcome is uncertain", async () => {
    const server = await serveResponses(
      Response.json({ requestToken: "token" }),
      Response.error(),
      Response.json({ requestToken: "token" }),
      Response.json(item),
    );
    const client = createProgressReviewClient(server.fetch);
    const intent = { reviewId, expectedRevision: 2, feedback: item.feedback };
    expect((await client.save(projectId, actorId, intent)).kind).toBe("unknown");
    expect((await client.save(projectId, actorId, intent)).kind).toBe("confirmed");
    const [, first, , retry] = server.requests;
    expect(await first?.text()).toBe(await retry?.text());
    expect(first?.headers.get("X-CSRF-TOKEN")).toBe("token");
    expect(first?.headers.get("X-Spatia-Account")).toBe(actorId);
  });
});
