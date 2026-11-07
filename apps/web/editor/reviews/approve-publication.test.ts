import { expect, it, vi } from "vitest";
import { approveAndPublish, readApprovalPublication } from "./approve-publication";

const projectId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const submissionId = "33333333-3333-4333-8333-333333333333";
const decisionId = "44444444-4444-4444-8444-444444444444";
const publicationId = "55555555-5555-4555-8555-555555555555";
const studentId = "66666666-6666-4666-8666-666666666666";
const intent = {
  projectId,
  actorId,
  studentId,
  submissionId,
  decisionId,
  publicationId,
  revision: 3,
  feedback: "Good work",
};
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const acknowledgement = {
  publicationId,
  projectId,
  sourceRevision: 3,
  createdAt: "2026-11-08T00:00:00Z",
  visitorUrl: `https://spatia.example/p/${publicationId}`,
};

it("publishes the approved exact revision as an unlisted edition", async () => {
  const store = memory();
  const decide = vi.fn(async () => ({ kind: "confirmed" as const }));
  const publish = vi.fn(async () => ({ kind: "confirmed" as const, value: acknowledgement }));
  const result = await approveAndPublish(store, intent, decide, publish);
  expect(result.kind).toBe("published");
  expect(decide).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId,
      submissionId,
      decisionId,
      expectedRevision: 3,
      outcome: "approved",
      feedback: "Good work",
    }),
    actorId,
  );
  expect(publish).toHaveBeenCalledWith(
    actorId,
    `/api/v1/projects/${projectId}/publications`,
    "POST",
    { publicationId, confirmedRevision: 3, intent: { audience: "Unlisted", viewerIds: [] } },
  );
  expect(store.getItem(`spatia-review-publication:${actorId}:${projectId}`)).toBeNull();
});

it("preserves the same request after unknown approval and does not publish early", async () => {
  const store = memory();
  const decide = vi.fn(async () => ({ kind: "unknown" as const }));
  const publish = vi.fn();
  expect((await approveAndPublish(store, intent, decide, publish)).kind).toBe("pending");
  expect(publish).not.toHaveBeenCalled();
  expect(store.getItem(`spatia-review-publication:${actorId}:${projectId}`)).toContain(decisionId);
});

it("keeps the original ids when publication fails after approval", async () => {
  const store = memory();
  const decide = vi.fn(async () => ({ kind: "confirmed" as const }));
  const publish = vi
    .fn()
    .mockResolvedValueOnce({ kind: "unknown" })
    .mockResolvedValueOnce({ kind: "confirmed", value: acknowledgement });
  expect((await approveAndPublish(store, intent, decide, publish)).kind).toBe("pending");
  expect((await approveAndPublish(store, intent, decide, publish)).kind).toBe("published");
  expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
  expect(decide.mock.calls[0]).toEqual(decide.mock.calls[1]);
});

it("does not resume a request for a different student", async () => {
  const store = memory();
  await approveAndPublish(
    store,
    intent,
    vi.fn(async () => ({ kind: "unknown" as const })),
    vi.fn(),
  );
  expect(() =>
    readApprovalPublication(store, actorId, projectId, "77777777-7777-4777-8777-777777777777"),
  ).toThrow();
});

it("reports confirmed publication even when clearing local storage fails", async () => {
  const store = {
    ...memory(),
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  };
  const result = await approveAndPublish(
    store,
    intent,
    vi.fn(async () => ({ kind: "confirmed" as const })),
    vi.fn(async () => ({ kind: "confirmed" as const, value: acknowledgement })),
  );
  expect(result.kind).toBe("published");
});
