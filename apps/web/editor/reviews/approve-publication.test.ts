import { beforeEach, expect, it } from "vitest";
import { serveHttp } from "../../tests/http-fixture";
import { createWorkspaceClient } from "../home/workspace-api";
import {
  approveAndPublish,
  readApprovalPublication,
  type ApprovalPublicationIntent,
} from "./approve-publication";
import { createReviewClient } from "./review-client";

const projectId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const submissionId = "33333333-3333-4333-8333-333333333333";
const decisionId = "44444444-4444-4444-8444-444444444444";
const publicationId = "55555555-5555-4555-8555-555555555555";
const studentId = "66666666-6666-4666-8666-666666666666";
const orgId = "77777777-7777-4777-8777-777777777777";
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
const storageKey = `spatia-review-publication:${actorId}:${projectId}`;
const projectPath = `/api/v1/projects/${projectId}`;
const decisionPath = `${projectPath}/submissions/${submissionId}/decisions`;
const publicationPath = `${projectPath}/publications`;
const createdAt = "2026-11-08T00:00:00Z";
const acknowledgement = {
  publicationId,
  projectId,
  sourceRevision: 3,
  createdAt,
  visitorUrl: `https://spatia.example/p/${publicationId}`,
};

beforeEach(() => sessionStorage.removeItem(storageKey));

function storageWithFailedRemoval() {
  return {
    getItem: sessionStorage.getItem.bind(sessionStorage),
    setItem: sessionStorage.setItem.bind(sessionStorage),
    removeItem: () => {
      throw new DOMException("Storage is unavailable", "SecurityError");
    },
  };
}

function approved(feedback = intent.feedback) {
  return Response.json(
    { submissionId, decisionId, outcome: "approved", feedback, sequence: 1, decidedAt: createdAt },
    { status: 201 },
  );
}

function published(status = 201) {
  return Response.json(acknowledgement, { status });
}

function publicationRejection(code?: string, status = 409) {
  return Response.json({ code }, { status });
}

async function approvalFlow(
  decisions: Response[],
  publications: Response[] = [],
  store: Pick<Storage, "getItem" | "setItem" | "removeItem"> = sessionStorage,
) {
  const server = await serveHttp((request) => {
    const path = new URL(request.url).pathname;
    switch (`${request.method} ${path}`) {
      case "GET /api/v1/auth/csrf":
        return Response.json({ requestToken: "token" });
      case "GET /api/v1/auth/session":
        return Response.json({
          userId: actorId,
          orgId,
          role: "Educator",
          displayName: "Teacher",
          mustChangePassword: false,
        });
      case `POST ${decisionPath}`: {
        const response = decisions.shift();
        if (response) return response;
        break;
      }
      case `POST ${publicationPath}`: {
        const response = publications.shift();
        if (response) return response;
        break;
      }
    }
    throw new Error(`Unexpected ${request.method} ${path}`);
  });
  const { execute } = createReviewClient(server.fetch);
  const { write } = createWorkspaceClient(server.fetch);
  return {
    run: (request: ApprovalPublicationIntent = intent, retry = false) =>
      approveAndPublish(store, request, execute, write, retry),
    recover: () => readApprovalPublication(store, actorId, projectId, studentId),
    posts: () => server.requests.filter((request) => request.method === "POST"),
    requests: server.requests,
  };
}

it("publishes the approved exact revision as an unlisted edition", async () => {
  const flow = await approvalFlow([approved()], [published()]);
  expect(await flow.run()).toEqual({ kind: "published", acknowledgement });
  const [decision, publication] = flow.posts();
  expect(flow.posts().map((request) => new URL(request.url).pathname)).toEqual([
    decisionPath,
    publicationPath,
  ]);
  expect(decision?.headers.get("X-Spatia-Account")).toBe(actorId);
  expect(publication?.headers.get("X-Spatia-Account")).toBe(actorId);
  expect(await decision?.json()).toEqual({
    decisionId,
    expectedRevision: 3,
    outcome: "approved",
    feedback: "Good work",
  });
  expect(await publication?.json()).toEqual({
    publicationId,
    confirmedRevision: 3,
    intent: { audience: "Unlisted", viewerIds: [] },
  });
  expect(flow.recover()).toBeNull();
});

it("preserves the same request after unknown approval and does not publish early", async () => {
  const flow = await approvalFlow([Response.error()]);
  expect((await flow.run()).kind).toBe("pending");
  expect(flow.posts().map((request) => new URL(request.url).pathname)).toEqual([decisionPath]);
  expect(flow.recover()).toEqual(intent);
});

it("keeps the original ids when publication fails after approval", async () => {
  const flow = await approvalFlow([approved(), approved()], [Response.error(), published(200)]);
  expect((await flow.run()).kind).toBe("pending");
  expect((await flow.run()).kind).toBe("published");
  const [decision, publication, retriedDecision, retriedPublication] = flow.posts();
  expect(await decision?.text()).toBe(await retriedDecision?.text());
  expect(await publication?.text()).toBe(await retriedPublication?.text());
});

it("retries publication without requiring optional review comments", async () => {
  const flow = await approvalFlow([approved(""), approved("")], [Response.error(), published(200)]);
  const withoutComment = { ...intent, feedback: "" };
  expect((await flow.run(withoutComment)).kind).toBe("pending");
  expect(flow.recover()).toEqual(withoutComment);
  expect((await flow.run(withoutComment)).kind).toBe("published");
});

it.each([false, true])(
  "handles a revision conflict after approval (prior uncertain response: %s)",
  async (previousUnknown) => {
    const conflict = publicationRejection("revision_conflict");
    const flow = previousUnknown
      ? await approvalFlow([approved(), approved()], [Response.error(), conflict])
      : await approvalFlow([approved()], [conflict]);
    if (previousUnknown) {
      expect((await flow.run()).kind).toBe("pending");
    }
    expect((await flow.run()).kind).toBe("revision-conflict");
    expect(flow.recover()).toBeNull();
    const posts = flow.posts();
    const decisions = posts.filter((request) => new URL(request.url).pathname === decisionPath);
    const publications = posts.filter(
      (request) => new URL(request.url).pathname === publicationPath,
    );
    expect(publications).toHaveLength(previousUnknown ? 2 : 1);
    for (const decision of decisions) {
      expect(await decision.json()).toMatchObject({ decisionId, feedback: "Good work" });
    }
  },
);

it("keeps the request pending if a conflict is confirmed but browser storage cannot clear it", async () => {
  const flow = await approvalFlow(
    [approved()],
    [publicationRejection("revision_conflict")],
    storageWithFailedRemoval(),
  );
  expect((await flow.run()).kind).toBe("pending");
  expect(flow.recover()).toEqual(intent);
});

it("does not resume a request for a different student", async () => {
  const flow = await approvalFlow([Response.error()]);
  await flow.run();
  expect(() => readApprovalPublication(sessionStorage, actorId, projectId, orgId)).toThrow();
});

it.each([
  ["unsupported_publication_runtime", 422, "publication-rejected"],
  ["publication_assets_unavailable", 422, "publication-rejected"],
  ["publication_id_conflict", 409, "pending"],
  [undefined, 409, "pending"],
])(
  "reconciles a stored request after publication rejects with %s",
  async (code, status, expected) => {
    sessionStorage.setItem(storageKey, JSON.stringify(intent));
    const flow = await approvalFlow([approved()], [publicationRejection(code, status)]);
    expect((await flow.run()).kind).toBe(expected);
    expect(await flow.posts()[1]?.json()).toMatchObject({ publicationId });
    expect(flow.recover()).toEqual(expected === "pending" ? intent : null);
  },
);

it("reports confirmed publication even when clearing local storage fails", async () => {
  const flow = await approvalFlow([approved()], [published()], storageWithFailedRemoval());
  expect(await flow.run()).toEqual({ kind: "published", acknowledgement });
  expect(flow.recover()).toEqual(intent);
});

it("rejects publication without a current submission", async () => {
  const flow = await approvalFlow([], []);
  expect((await flow.run({ ...intent, submissionId: null })).kind).toBe("rejected");
  expect(flow.requests).toHaveLength(0);
  expect(flow.recover()).toBeNull();
});

it("clears a definitive first publication rejection so the teacher can try again", async () => {
  const flow = await approvalFlow([approved("")], [publicationRejection()]);
  expect(await flow.run({ ...intent, feedback: "" })).toEqual({
    kind: "publication-rejected",
    message:
      "Your approval and feedback were saved. Publication was rejected. The record changed or already exists. Refresh before trying again.",
  });
  expect(flow.recover()).toBeNull();
});

it("retains the original publication after an uncertain outcome followed by rejection", async () => {
  const flow = await approvalFlow(
    [approved(""), approved("")],
    [Response.error(), publicationRejection()],
  );
  const direct = { ...intent, feedback: "" };
  expect((await flow.run(direct)).kind).toBe("pending");
  expect((await flow.run(direct)).kind).toBe("pending");
  expect(flow.recover()).toEqual(direct);
});

it("keeps an explicit retry uncertain if another tab already cleared storage", async () => {
  const flow = await approvalFlow([approved()], [publicationRejection()]);
  expect((await flow.run(intent, true)).kind).toBe("pending");
  expect(flow.recover()).toEqual(intent);
  expect(await flow.posts()[1]?.json()).toMatchObject({ publicationId });
});

it("approves without publishing and preserves that choice across uncertain retries", async () => {
  const flow = await approvalFlow([Response.error(), approved()]);
  const approval = { ...intent, approvalOnly: true as const };
  expect((await flow.run(approval)).kind).toBe("pending");
  const recovered = flow.recover();
  expect(recovered?.approvalOnly).toBe(true);
  if (!recovered) throw new Error("Expected a saved approval");
  expect((await flow.run(recovered, true)).kind).toBe("approved");
  const [decision, retriedDecision] = flow.posts();
  expect(await decision?.text()).toBe(await retriedDecision?.text());
  expect(flow.posts().map((request) => new URL(request.url).pathname)).toEqual([
    decisionPath,
    decisionPath,
  ]);
  expect(flow.recover()).toBeNull();
});

it("keeps confirmed approval retryable if recovery storage cannot be cleared", async () => {
  const flow = await approvalFlow([approved()], [], storageWithFailedRemoval());
  const approval = { ...intent, approvalOnly: true as const };
  expect((await flow.run(approval)).kind).toBe("pending");
  expect(flow.recover()?.approvalOnly).toBe(true);
  expect(flow.posts().map((request) => new URL(request.url).pathname)).toEqual([decisionPath]);
});
