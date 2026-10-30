import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { createServerAutosave } from "./server-autosave";
import type { ServerDraftRequest, ServerDraftResult } from "./server-draft-write";

const assetKinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
const loaded = deserializeProject(JSON.stringify(fixture), assetKinds);
if (!loaded.ok) throw new Error("Invalid test fixture");
const document = loaded.value;
// Changing the title gives each snapshot a recognisable edit while keeping the scene valid
const changed = (title: string) => ({ ...document, title });

function saved(request: ServerDraftRequest): ServerDraftResult {
  // Reply to the exact mutation supplied by autosave
  // Tests that need a failure override this default response
  const body = JSON.parse(request.body);
  return {
    kind: "saved",
    receipt: {
      projectId: request.projectId,
      clientMutationId: body.clientMutationId,
      revision: body.expectedRevision + 1,
    },
  };
}

function setup() {
  const write = vi
    .fn<(request: ServerDraftRequest, signal: AbortSignal) => Promise<ServerDraftResult>>()
    .mockImplementation(async (request) => saved(request));
  const onStatus = vi.fn();
  const session = createServerAutosave({ document, revision: 3, assetKinds, onStatus, write });
  return { session, write, onStatus };
}

// Control both the quiet period and maximum delay without waiting on wall-clock time
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("server autosave scheduling", () => {
  it("coalesces edits after two seconds and leaves an unchanged document alone", async () => {
    const { session, write, onStatus } = setup();
    // An unchanged document never creates a request or a save timer
    session.changed(document);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();
    // A later edit extends the quiet period and replaces the pending snapshot
    session.changed(changed("First"));
    await vi.advanceTimersByTimeAsync(1_000);
    session.changed(changed("Second"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0].body).document.title).toBe("Second");
    expect(onStatus).toHaveBeenLastCalledWith("saved");
    session.dispose();
  });

  it("saves after five seconds even while edits keep arriving", async () => {
    const { session, write } = setup();
    // Continuous editing must still flush after the maximum delay
    for (let i = 0; i < 5; i += 1) {
      session.changed(changed(`Edit ${i}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(write).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("waits for one request before saving newer edits against its confirmed revision", async () => {
    const { session, write, onStatus } = setup();
    let finish!: (result: ServerDraftResult) => void;
    // Hold the first response so another edit can arrive while saving is still in progress
    write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    session.changed(changed("First"));
    const firstSave = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    session.changed(changed("Second"));
    // Manual Save joins the active request and waits for its receipt
    const joinedSave = session.flush();
    expect(joinedSave).toBe(firstSave);
    expect(write).toHaveBeenCalledTimes(1);
    finish(saved(write.mock.calls[0]![0]));
    await joinedSave;
    expect(onStatus).toHaveBeenLastCalledWith("unsaved");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(JSON.parse(write.mock.calls[1]![0].body).expectedRevision).toBe(4);
    expect(onStatus).toHaveBeenLastCalledWith("saved");
    session.dispose();
  });

  it("retries identical bytes after a lost response before sending subsequent edits", async () => {
    const { session, write } = setup();
    // An uncertain failure keeps the original request bytes and mutation identity
    write.mockResolvedValueOnce({ kind: "failed" });
    session.changed(changed("First"));
    await session.flush();
    session.changed(changed("Second"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    await session.flush();
    expect(write.mock.calls[1]![0]).toBe(write.mock.calls[0]![0]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(JSON.parse(write.mock.calls[2]![0].body).document.title).toBe("Second");
    session.dispose();
  });

  it.each(["conflict", "rejected"] as const)(
    "pauses on %s without overwriting or retrying",
    async (kind) => {
      const { session, write, onStatus } = setup();
      // Conflicts and rejected sessions require an explicit decision before another write
      write.mockResolvedValueOnce({ kind });
      session.changed(changed("First"));
      await session.flush();
      session.changed(changed("Keep these edits"));
      await session.flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenLastCalledWith(kind);
      session.dispose();
    },
  );
});
