import { describe, expect, it } from "vitest";
import { serveResponses } from "../../tests/http-fixture";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { readServerProject } from "./server-project-read";

// Use a released project and its approved assets to exercise the real shared reader
const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
const session = { userId: "alice", mustChangePassword: false };
const envelope = {
  projectId: fixture.projectId,
  revision: 7,
  document: fixture,
  permissions: { canEdit: true },
};

function responses(project: unknown = envelope, finalAccount: unknown = session) {
  // The two session responses surround the project read so account changes cannot go unnoticed
  return serveResponses(
    Response.json(session),
    Response.json(project),
    Response.json(finalAccount),
  );
}

const read = (fetcher: typeof fetch, signal = new AbortController().signal) =>
  readServerProject(fixture.projectId, "alice", assets, signal, fetcher);

describe("authenticated project opening", () => {
  it("returns validated content and retains read-only permissions", async () => {
    // Open the server response as a candidate and retain its read-only permission
    const { fetch: fetcher, requests } = await responses({
      ...envelope,
      permissions: { canEdit: false },
    });
    expect(await read(fetcher)).toMatchObject({
      ok: true,
      value: {
        accountId: "alice",
        revision: 7,
        canEdit: false,
        document: { projectId: fixture.projectId },
      },
    });
    // Project reads use the current same-origin session and never reuse a cached response
    expect(new URL(requests[1]!.url).pathname).toBe(`/api/v1/projects/${fixture.projectId}`);
    expect(requests[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("rejects a response if the active account changed during loading", async () => {
    // A response arriving after an account switch must never replace the active draft
    expect(
      await read((await responses(envelope, { ...session, userId: "bob" })).fetch),
    ).toMatchObject({
      ok: false,
    });
  });

  // Check the envelope and embedded document before offering the result to the editor
  it.each([
    { ...envelope, revision: -1 },
    { ...envelope, projectId: crypto.randomUUID() },
    { ...envelope, document: { ...fixture, projectId: crypto.randomUUID() } },
    { ...envelope, document: { ...fixture, version: 999 } },
    { ...envelope, permissions: {} },
  ])("rejects malformed or mismatched server content", async (body) => {
    expect(await read((await responses(body)).fetch)).toMatchObject({ ok: false });
  });

  it("does not request project content after an expired session or cancellation", async () => {
    // Expired and cancelled sessions stop before fetching any project content
    const { fetch: fetcher, requests } = await serveResponses(new Response(null, { status: 401 }));
    expect(await read(fetcher)).toMatchObject({ ok: false });
    expect(requests).toHaveLength(1);
    const cancelled = await serveResponses();
    expect(await read(cancelled.fetch, AbortSignal.abort())).toMatchObject({ ok: false });
    expect(cancelled.requests).toHaveLength(0);
  });
});
