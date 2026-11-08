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
    expect.objectContaining({ revision_conflict: expect.any(String) }),
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

it("retries publication without requiring optional review comments", async () => {
  const store = memory();
  const withoutComment = { ...intent, feedback: "" };
  const decide = vi.fn(async () => ({ kind: "confirmed" as const }));
  const publish = vi.fn().mockResolvedValueOnce({ kind: "unknown" }).mockResolvedValueOnce({
    kind: "confirmed",
    value: acknowledgement,
  });
  expect((await approveAndPublish(store, withoutComment, decide, publish)).kind).toBe("pending");
  expect(readApprovalPublication(store, actorId, projectId, studentId)).toEqual(withoutComment);
  expect((await approveAndPublish(store, withoutComment, decide, publish)).kind).toBe("published");
});

it.each([false, true])(
  "handles a revision conflict after approval (prior uncertain response: %s)",
  async (previousUnknown) => {
    const store = memory();
    const decide = vi.fn(async () => ({ kind: "confirmed" as const }));
    const publish = vi.fn();
    if (previousUnknown) {
      publish.mockResolvedValueOnce({ kind: "unknown" });
      expect((await approveAndPublish(store, intent, decide, publish)).kind).toBe("pending");
    }
    publish.mockResolvedValueOnce({
      kind: "rejected",
      code: "revision_conflict",
      message: "The project changed.",
    });
    expect((await approveAndPublish(store, intent, decide, publish)).kind).toBe(
      previousUnknown ? "pending" : "revision-conflict",
    );
    expect(readApprovalPublication(store, actorId, projectId, studentId)).toEqual(
      previousUnknown ? intent : null,
    );
    expect(publish).toHaveBeenCalledTimes(previousUnknown ? 2 : 1);
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId, feedback: "Good work" }),
      actorId,
    );
  },
);

it("keeps the request pending if a conflict is confirmed but browser storage cannot clear it", async () => {
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
    vi.fn(async () => ({
      kind: "rejected" as const,
      code: "revision_conflict",
      message: "Changed",
    })),
  );
  expect(result.kind).toBe("pending");
  expect(readApprovalPublication(store, actorId, projectId, studentId)).toEqual(intent);
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

it("saves progress feedback before direct publication and retries the same identities", async () => {
  const store = memory();
  const direct = { ...intent, submissionId: null };
  const decide = vi.fn();
  const save = vi
    .fn()
    .mockResolvedValueOnce({ kind: "unknown" })
    .mockResolvedValueOnce({
      kind: "confirmed",
      item: { id: decisionId, revision: 3, feedback: "Good work" },
    });
  const publish = vi.fn(async () => ({ kind: "confirmed" as const, value: acknowledgement }));
  expect((await approveAndPublish(store, direct, decide, publish, save)).kind).toBe("pending");
  expect(publish).not.toHaveBeenCalled();
  expect(readApprovalPublication(store, actorId, projectId, studentId)).toEqual(direct);
  expect((await approveAndPublish(store, direct, decide, publish, save)).kind).toBe("published");
  expect(save.mock.calls[0]).toEqual([
    projectId,
    actorId,
    {
      reviewId: decisionId,
      expectedRevision: 3,
      feedback: "Good work",
    },
  ]);
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(decide).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledWith(
    actorId,
    `/api/v1/projects/${projectId}/publications`,
    "POST",
    {
      publicationId,
      confirmedRevision: 3,
      intent: { audience: "Unlisted", viewerIds: [], teacherOverride: true },
    },
    expect.any(Object),
  );
});

it("publishes directly without saving a blank review", async () => {
  const save = vi.fn();
  const decide = vi.fn();
  const publish = vi.fn(async () => ({ kind: "confirmed" as const, value: acknowledgement }));
  const result = await approveAndPublish(
    memory(),
    { ...intent, submissionId: null, feedback: "" },
    decide,
    publish,
    save,
  );
  expect(result.kind).toBe("published");
  expect(save).not.toHaveBeenCalled();
  expect(decide).not.toHaveBeenCalled();
});

it("retries direct publication with the same override after an uncertain response", async () => {
  const store = memory();
  const direct = { ...intent, submissionId: null, feedback: "" };
  const publish = vi.fn().mockResolvedValueOnce({ kind: "unknown" }).mockResolvedValueOnce({
    kind: "confirmed",
    value: acknowledgement,
  });
  expect((await approveAndPublish(store, direct, vi.fn(), publish, vi.fn())).kind).toBe("pending");
  expect(() =>
    readApprovalPublication(store, actorId, projectId, "77777777-7777-4777-8777-777777777777"),
  ).toThrow();
  expect((await approveAndPublish(store, direct, vi.fn(), publish, vi.fn())).kind).toBe(
    "published",
  );
  expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
});

it("clears a definitive first publication rejection so the teacher can try again", async () => {
  const store = memory();
  const direct = { ...intent, submissionId: null, feedback: "" };
  const result = await approveAndPublish(
    store,
    direct,
    vi.fn(),
    vi.fn(async () => ({ kind: "rejected" as const, message: "Publishing is unavailable." })),
    vi.fn(),
  );
  expect(result).toEqual({ kind: "rejected", message: "Publishing is unavailable." });
  expect(readApprovalPublication(store, actorId, projectId, studentId)).toBeNull();
});

it("retains the original publication after an uncertain outcome followed by rejection", async () => {
  const store = memory();
  const direct = { ...intent, submissionId: null, feedback: "" };
  const publish = vi.fn().mockResolvedValueOnce({ kind: "unknown" }).mockResolvedValueOnce({
    kind: "rejected",
    message: "Try later.",
  });
  expect((await approveAndPublish(store, direct, vi.fn(), publish, vi.fn())).kind).toBe("pending");
  expect((await approveAndPublish(store, direct, vi.fn(), publish, vi.fn())).kind).toBe("pending");
  expect(readApprovalPublication(store, actorId, projectId, studentId)).toEqual(direct);
});
