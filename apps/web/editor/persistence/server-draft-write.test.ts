import { describe, expect, it, vi } from "vitest";
import { writeServerDraft } from "./server-draft-write";

// Transport receives a body already prepared by autosave
// Use a small body here to spot accidental changes without rebuilding a full scene
const request = { projectId: "project-a", body: '{"captured":"request"}' };
const signal = new AbortController().signal;
const receipt = { projectId: "project-a", clientMutationId: "save-a", revision: 1 };

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
    expect(fetcher).toHaveBeenLastCalledWith("/api/projects/project-a", {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "csrf-token" },
      body: request.body,
    });
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
});
