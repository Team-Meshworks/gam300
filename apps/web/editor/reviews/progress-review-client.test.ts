import { describe, expect, it, vi } from "vitest";
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
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("progress review client", () => {
  it("reads dated feedback and follows the project-scoped cursor", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: [item], nextCursor: reviewId }))
      .mockResolvedValueOnce(json({ userId: actorId, role: "Creator", mustChangePassword: false }));
    expect(
      await createProgressReviewClient(request).list(projectId, actorId, "Creator", reviewId),
    ).toEqual({
      items: [item],
      nextCursor: reviewId,
    });
    expect(request.mock.calls[0]![0]).toBe(
      `/api/v1/projects/${projectId}/progress-reviews?limit=20&cursor=${reviewId}`,
    );
    expect(request.mock.calls[0]![1]?.headers).toMatchObject({ "X-Spatia-Account": actorId });
  });
  it("does not return private feedback when the account changes during the read", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: [item], nextCursor: null }))
      .mockResolvedValueOnce(
        json({ userId: projectId, role: "Creator", mustChangePassword: false }),
      );
    await expect(
      createProgressReviewClient(request).list(projectId, actorId, "Creator"),
    ).rejects.toThrow();
  });
  it("keeps the same id and input when a write outcome is uncertain", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json(item, 200));
    const client = createProgressReviewClient(request);
    const intent = { reviewId, expectedRevision: 2, feedback: item.feedback };
    expect((await client.save(projectId, actorId, intent)).kind).toBe("unknown");
    expect((await client.save(projectId, actorId, intent)).kind).toBe("confirmed");
    expect(request.mock.calls[1]![1]?.body).toBe(request.mock.calls[3]![1]?.body);
    expect(request.mock.calls[1]![1]?.headers).toMatchObject({
      "X-CSRF-TOKEN": "token",
      "X-Spatia-Account": actorId,
    });
  });
});
