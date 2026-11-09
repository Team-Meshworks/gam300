import { afterEach, describe, expect, it, vi } from "vitest";
import { writeServerDraft } from "./server-draft-write";

// Transport receives a body already prepared by autosave
// Use a small body here to spot accidental changes without rebuilding a full scene
const request = { projectId: "project-a", body: '{"captured":"request"}' };
const signal = new AbortController().signal;
const receipt = { projectId: "project-a", clientMutationId: "save-a", revision: 1 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function responses(response: Response) {
  // First fetch gets the CSRF token; second fetch sends the draft
  // Supplied responses keep these tests independent of a running backend
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ requestToken: "csrf-token" }))
    .mockResolvedValueOnce(response);
}

describe("server draft transport", () => {
  it("sends the captured body with the server's CSRF token and same-origin cookies", async () => {
    const fetcher = responses(Response.json(receipt));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "saved", receipt });
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/projects/project-a", {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "csrf-token" },
      body: request.body,
    });

    // Repeated successful saves must release fallback subscriptions before the session ends
    class OlderAbortSignal extends AbortSignal {}
    Object.defineProperty(OlderAbortSignal, "any", { value: undefined });
    vi.stubGlobal("AbortSignal", OlderAbortSignal);
    const account = new AbortController();
    const added = vi.spyOn(account.signal, "addEventListener");
    const removed = vi.spyOn(account.signal, "removeEventListener");
    for (let save = 0; save < 50; save += 1) {
      expect(
        await writeServerDraft(request, account.signal, responses(Response.json(receipt))),
      ).toEqual({ kind: "saved", receipt });
      expect(added).toHaveBeenCalledTimes(save + 1);
      expect(removed).toHaveBeenCalledTimes(save + 1);
    }
    expect(account.signal.aborted).toBe(false);
  });

  it("binds token and save requests to the originating account even after cookies change", async () => {
    const fetcher = responses(Response.json(receipt));
    await writeServerDraft(request, signal, fetcher, "original-account");
    // Both hops must reject a different cookie owner before draft bytes can be accepted
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("X-Spatia-Account")).toBe("original-account");
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
      await writeServerDraft(request, signal, responses(new Response(null, { status }))),
    ).toEqual({ kind });
  });

  it("does not send a draft when the CSRF bootstrap is invalid", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ requestToken: null }));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed success receipt as an unconfirmed write", async () => {
    const fetcher = responses(Response.json({ ...receipt, revision: "1" }));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
  });

  it("preserves uncertainty when the connection drops after sending", async () => {
    // Token succeeds, then the save loses its response
    // Nothing here tells us whether the server committed before the connection dropped
    const fetcher = responses(Response.json(receipt));
    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(Response.json({ requestToken: "csrf-token" }));
    fetcher.mockRejectedValueOnce(new TypeError("Connection lost"));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "failed" });
  });

  it.each([401, 403])("pauses when CSRF bootstrap rejects the session with %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    expect(await writeServerDraft(request, signal, fetcher)).toEqual({ kind: "rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled request without claiming that the server rolled it back", async () => {
    vi.useFakeTimers();
    // Leave the save unresolved until its abort signal fires
    // Advancing the test clock exercises the deadline without a real fifteen-second wait
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ requestToken: "csrf-token" }))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      );
    const saving = writeServerDraft(request, signal, fetcher);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await saving).toEqual({ kind: "failed" });
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the request when its owning account session ends", async () => {
    const account = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const saving = writeServerDraft(request, account.signal, fetcher);
    account.abort();
    // Retry after logout as well; an ended session must not begin another fetch
    expect(await saving).toEqual({ kind: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await writeServerDraft(request, account.signal, fetcher)).toEqual({ kind: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
