import { describe, expect, it } from "vitest";
import { deferred } from "../../tests/deferred";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { writeServerDraft } from "./server-draft-write";

// Transport receives a body already prepared by autosave
// Use a small body here to spot accidental changes without rebuilding a full scene
const request = { projectId: "project-a", body: '{"captured":"request"}' };
const signal = new AbortController().signal;
const receipt = { projectId: "project-a", clientMutationId: "save-a", revision: 1 };

function responses(response: Response) {
  // First fetch gets the CSRF token; second fetch sends the draft
  // Supplied responses keep these tests independent of a running backend
  return serveResponses(Response.json({ requestToken: "csrf-token" }), response);
}

describe("server draft transport", () => {
  it("sends the captured body with the server's CSRF token and same-origin cookies", async () => {
    const { fetch: fetcher, requests } = await responses(Response.json(receipt));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "saved", receipt });
    const sent = requests.at(-1)!;
    expect(new URL(sent.url).pathname).toBe("/api/v1/projects/project-a");
    expect(sent).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get("X-CSRF-TOKEN")).toBe("csrf-token");
    expect(await sent.text()).toBe(request.body);
  });

  it("binds token and save requests to the originating account even after cookies change", async () => {
    const { fetch: fetcher, requests } = await responses(Response.json(receipt));
    await writeServerDraft(request, signal, fetcher, "original-account");
    // Both hops must reject a different cookie owner before draft bytes can be accepted
    for (const sent of requests) {
      expect(sent.headers.get("X-Spatia-Account")).toBe("original-account");
    }
  });

  it.each([
    [409, "conflict"],
    [401, "rejected"],
    [403, "rejected"],
    [422, "rejected"],
    [503, "failed"],
  ])("keeps HTTP %s distinct from confirmed saving", async (status, kind) => {
    expect(
      await writeServerDraft(
        request,
        signal,
        (await responses(new Response(null, { status }))).fetch,
      ),
    ).toEqual({ kind });
  });

  it("does not send a draft when the CSRF bootstrap is invalid", async () => {
    const { fetch: fetcher, requests } = await serveResponses(
      Response.json({ requestToken: null }),
    );
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [{ code: "invalid_document" }, "invalid"],
    [{ code: "project_id_mismatch" }, "rejected"],
    [{}, "rejected"],
  ])("distinguishes a known uncommitted document rejection: %j", async (problem, kind) => {
    expect(
      await writeServerDraft(
        request,
        signal,
        (await responses(Response.json(problem, { status: 422 }))).fetch,
      ),
    ).toEqual({ kind });
  });

  it("treats a malformed success receipt as an unconfirmed write", async () => {
    const { fetch: fetcher } = await responses(Response.json({ ...receipt, revision: "1" }));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
  });

  it("preserves uncertainty when the connection drops after sending", async () => {
    // Token succeeds, then the save loses its response
    // Nothing here tells us whether the server committed before the connection dropped
    const { fetch: fetcher } = await responses(Response.error());
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
  });

  it.each([401, 403])("pauses when CSRF bootstrap rejects the session with %s", async (status) => {
    const { fetch: fetcher, requests } = await serveResponses(new Response(null, { status }));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "rejected" });
    expect(requests).toHaveLength(1);
  });

  it("bounds a stalled request without claiming that the server rolled it back", async () => {
    const received = deferred<void>();
    const disconnected = deferred<void>();
    const deadline = deferred<{ expire: () => void; milliseconds: number }>();
    let deadlineCancelled = false;
    const { fetch: fetcher, requests } = await serveHttp(({ method, signal: requestSignal }) => {
      if (method === "GET") return Response.json({ requestToken: "csrf-token" });
      const cancelled = new Promise<Response>((resolve) => {
        requestSignal.addEventListener(
          "abort",
          () => {
            disconnected.resolve();
            resolve(Response.error());
          },
          { once: true },
        );
      });
      received.resolve();
      return cancelled;
    });
    const saving = writeServerDraft(request, signal, fetcher, undefined, (expire, milliseconds) => {
      deadline.resolve({ expire, milliseconds });
      return () => {
        deadlineCancelled = true;
      };
    });
    const { expire, milliseconds } = await deadline.promise;
    expect(milliseconds).toBe(15_000);
    await received.promise;
    expect(requests[1]?.signal.aborted).toBe(false);
    expire();
    await disconnected.promise;
    expect(await saving).toEqual({ kind: "failed" });
    expect(requests[1]?.signal.aborted).toBe(true);
    expect(deadlineCancelled).toBe(true);
  });

  it("cancels the request when its owning account session ends", async () => {
    const account = new AbortController();
    const received = deferred<void>();
    const { fetch: fetcher, requests } = await serveHttp(({ signal: requestSignal }) => {
      const cancelled = new Promise<Response>((resolve) => {
        requestSignal.addEventListener("abort", () => resolve(Response.error()), { once: true });
      });
      received.resolve();
      return cancelled;
    });
    const saving = writeServerDraft(request, account.signal, fetcher);
    await received.promise;
    account.abort();
    // Retry after logout as well; an ended session must not begin another fetch
    expect(await saving).toEqual({ kind: "failed" });
    expect(requests).toHaveLength(1);
    expect(await writeServerDraft(request, account.signal, fetcher)).toEqual({ kind: "failed" });
    expect(requests).toHaveLength(1);
  });
});
