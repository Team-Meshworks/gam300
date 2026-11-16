import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { createServerAutosave, type ServerSaveSnapshot } from "./server-autosave";
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
  const session = createServerAutosave({
    document,
    revision: 3,
    assetKinds,
    onStatus,
    write,
    checkpoint: async () => true,
  });
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

  it("reconciles a lost save receipt while a newer link is unfinished", async () => {
    const { session, write } = setup();
    write.mockResolvedValueOnce({ kind: "failed" });
    session.changed(changed("Sent before disconnect"));
    await session.flush();
    const original = write.mock.calls[0]![0];
    const draft = {
      ...document,
      schemaVersion: 1 as const,
      scenes: document.scenes.map((scene) => ({
        ...scene,
        interactions: [
          { when: { type: "scene-starts" as const }, do: { type: "open-link" as const, url: "" } },
        ],
      })),
    };
    expect(session.changed(draft)).toBe(true);
    await session.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0]).toBe(original);
    expect(session.getRecovery().serverSave).toMatchObject({ revision: 4, pending: null });
    expect(session.getRecovery().document).toEqual(draft);
    expect(session.getStatus()).toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(2);
    session.changed(changed("Corrected offline"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(3);
    const corrected = JSON.parse(write.mock.calls[2]![0].body);
    expect(corrected.expectedRevision).toBe(4);
    expect(corrected.clientMutationId).not.toBe(JSON.parse(original.body).clientMutationId);
    expect(corrected.document.title).toBe("Corrected offline");
    expect(session.getStatus()).toBe("saved");
    await session.dispose();
  });

  it.each(["during", "after"] as const)(
    "saves corrections made %s a definite document rejection with a fresh mutation",
    async (timing) => {
      const { session, write } = setup();
      let finish!: (result: ServerDraftResult) => void;
      write.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      session.changed(changed("Rejected content"));
      const saving = session.flush();
      await vi.advanceTimersByTimeAsync(0);
      const rejected = JSON.parse(write.mock.calls[0]![0].body);
      if (timing === "during") session.changed(changed("Corrected content"));
      finish({ kind: "invalid" });
      await saving;
      expect(session.getRecovery().serverSave).toMatchObject({ revision: 3, pending: null });
      if (timing === "after") {
        expect(session.getStatus()).toBe("invalid");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(write).toHaveBeenCalledTimes(1);
        session.changed(changed("Corrected content"));
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).toHaveBeenCalledTimes(2);
      const corrected = JSON.parse(write.mock.calls[1]![0].body);
      expect(corrected.clientMutationId).not.toBe(rejected.clientMutationId);
      expect(corrected).toMatchObject({
        expectedRevision: 3,
        document: { title: "Corrected content" },
      });
      expect(session.getStatus()).toBe("saved");
      await session.dispose();
    },
  );

  it.each(["conflict", "rejected"] as const)(
    "keeps %s paused through an invalid local edit and its correction",
    async (kind) => {
      const { session, write } = setup();
      write.mockResolvedValueOnce({ kind });
      session.changed(changed("Unconfirmed content"));
      await session.flush();
      const draft = {
        ...document,
        schemaVersion: 1 as const,
        scenes: document.scenes.map((scene) => ({
          ...scene,
          interactions: [
            {
              when: { type: "scene-starts" as const },
              do: { type: "open-link" as const, url: "" },
            },
          ],
        })),
      };
      expect(session.changed(draft)).toBe(true);
      expect(session.getStatus()).toBe(kind);
      session.changed(changed("Corrected local content"));
      await session.flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(session.getStatus()).toBe(kind);
      expect(session.getRecovery().serverSave.pending).not.toBeNull();
      await session.dispose();
    },
  );

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

  it("cancels pending work and ignores late responses after leaving the session", async () => {
    const { session, write, onStatus } = setup();
    let finish!: (result: ServerDraftResult) => void;
    write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    session.changed(changed("First"));
    const saving = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    // Leaving aborts the old request and suppresses its late status updates
    session.dispose();
    const statusCount = onStatus.mock.calls.length;
    expect(write.mock.calls[0]![1].aborted).toBe(true);
    finish(saved(write.mock.calls[0]![0]));
    await saving;
    expect(onStatus).toHaveBeenCalledTimes(statusCount);
    expect(session.changed(changed("After logout"))).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong-project and invalid snapshots before scheduling writes", async () => {
    const { session, write } = setup();
    // Neither a different project nor invalid authored data may start a save
    expect(session.changed({ ...document, projectId: crypto.randomUUID() })).toBe(false);
    expect(session.changed({ ...document, scenes: [] })).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();
    session.dispose();
  });
});

describe("server autosave recovery", () => {
  it("preserves edits when the server revision cannot advance further", async () => {
    const backup = vi.fn(async () => true);
    const write = vi.fn(async (request: ServerDraftRequest) => saved(request));
    const session = createServerAutosave({
      document,
      revision: Number.MAX_SAFE_INTEGER,
      assetKinds,
      onStatus: vi.fn(),
      checkpoint: backup,
      write,
    });
    // Preserve the local edit when the revision counter cannot safely increase
    session.changed(changed("Keep this edit"));
    await session.flush();
    expect(write).not.toHaveBeenCalled();
    expect(backup).toHaveBeenCalledTimes(1);
    expect(session.getStatus()).toBe("rejected");
    await session.dispose();
  });

  it("reopens an uncertain save with identical bytes before saving newer edits", async () => {
    let snapshot!: ServerSaveSnapshot;
    const backup = vi.fn(async (captured: ServerSaveSnapshot) => {
      snapshot = captured;
      return true;
    });
    const firstWrite = vi.fn(async (): Promise<ServerDraftResult> => ({ kind: "failed" }));
    const first = createServerAutosave({
      document,
      revision: 3,
      assetKinds,
      onStatus: vi.fn(),
      checkpoint: backup,
      write: firstWrite,
    });
    // Preserve the original in-flight snapshot separately from later offline edits
    first.changed(changed("Sent before disconnect"));
    await first.flush();
    first.changed(changed("Edited offline"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(firstWrite).toHaveBeenCalledTimes(1);
    expect(snapshot.document.title).toBe("Edited offline");
    expect(JSON.parse(snapshot.serverSave.pending!.documentJson).title).toBe(
      "Sent before disconnect",
    );
    const originalPending = snapshot.serverSave.pending;
    first.dispose();

    // Start a fresh owner using only the stored scene and retry metadata
    // Its first request must still refer to the edit sent before the disconnect
    const write = vi.fn(async (request: ServerDraftRequest) => saved(request));
    const reopened = createServerAutosave({
      document: changed("Edited offline"),
      revision: 3,
      assetKinds,
      onStatus: vi.fn(),
      recovery: snapshot.serverSave,
      checkpoint: backup,
      write,
    });
    expect(reopened.getStatus()).toBe("unsaved");
    await reopened.flush();
    // Retry the original mutation before advancing to the later edited document
    const replay = JSON.parse(write.mock.calls[0]![0].body);
    expect(replay.clientMutationId).toBe(originalPending!.clientMutationId);
    expect(replay.document.title).toBe("Sent before disconnect");
    expect(replay.expectedRevision).toBe(3);
    expect(reopened.getStatus()).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(JSON.parse(write.mock.calls[1]![0].body)).toMatchObject({
      expectedRevision: 4,
      document: { title: "Edited offline" },
    });
    expect(snapshot.serverSave.pending).toBeNull();
    expect(snapshot.serverSave.revision).toBe(5);
    expect(reopened.getStatus()).toBe("saved");
    reopened.dispose();
  });

  it("does not send when the recovery write fails and retries after storage recovers", async () => {
    // Fail the local backup first, then let storage work on the next attempt
    // The server must receive nothing until the retry identity is safely stored
    const backup = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const write = vi.fn(async (request: ServerDraftRequest) => saved(request));
    const session = createServerAutosave({
      document,
      revision: 3,
      assetKinds,
      onStatus: vi.fn(),
      checkpoint: backup,
      write,
    });
    session.changed(changed("Keep in memory"));
    await session.flush();
    expect(write).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe("failed");
    // Storage recovery retries the same captured mutation instead of creating a new one
    const mutation = backup.mock.calls[0]![0].serverSave.pending.clientMutationId;
    await session.flush();
    expect(JSON.parse(write.mock.calls[0]![0].body).clientMutationId).toBe(mutation);
    expect(session.getStatus()).toBe("saved");
    session.dispose();
  });

  it("backs up edits during a conflict without sending them over the server copy", async () => {
    const backup = vi.fn(async () => true);
    const write = vi.fn(async (): Promise<ServerDraftResult> => ({ kind: "conflict" }));
    const session = createServerAutosave({
      document,
      revision: 3,
      assetKinds,
      onStatus: vi.fn(),
      checkpoint: backup,
      write,
    });
    session.changed(changed("Conflicting edit"));
    await session.flush();
    session.changed(changed("More local work"));
    // A conflict pauses server writes while local recovery continues accepting edits
    await session.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledTimes(2);
    expect(session.getStatus()).toBe("conflict");
    session.dispose();
  });

  it("cancels before sending if the account changes while recovery storage is busy", async () => {
    let finish!: (ok: boolean) => void;
    const backup = vi
      .fn<(snapshot: ServerSaveSnapshot) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    const write = vi.fn(async (request: ServerDraftRequest) => saved(request));
    const onStatus = vi.fn();
    const session = createServerAutosave({
      document,
      revision: 3,
      assetKinds,
      onStatus,
      checkpoint: backup,
      write,
    });
    session.changed(changed("Old account"));
    // An account change during the backup cancels the request before network delivery
    const saving = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    session.dispose();
    const count = onStatus.mock.calls.length;
    finish(true);
    await saving;
    expect(write).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(count);
  });
});
