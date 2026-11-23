import { once } from "node:events";
import { IDBFactory } from "fake-indexeddb";
import { deferred } from "../../tests/deferred";
import { serveHttp } from "../../tests/http-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { deserializeProject } from "../../shared/project/project-deserialization";
import {
  createServerAutosave,
  type ServerSaveSnapshot,
  type ServerSaveStatus,
} from "./server-autosave";
import { writeServerDraft } from "./server-draft-write";
import { IndexedDBDraftDatabase } from "./draft-db";
import { applySaveRecoverySession, getRecoverySession } from "./recovery-session";

const assetKinds = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
const loaded = deserializeProject(JSON.stringify(fixture), assetKinds);
if (!loaded.ok) throw new Error("Invalid test fixture");
const document = loaded.value;
// Changing the title gives each snapshot a recognisable edit while keeping the scene valid
const changed = (title: string) => ({ ...document, title });

function saveBody(body: string) {
  const parsed: unknown = JSON.parse(body);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("clientMutationId" in parsed) ||
    typeof parsed.clientMutationId !== "string" ||
    !("expectedRevision" in parsed) ||
    typeof parsed.expectedRevision !== "number" ||
    !("document" in parsed)
  )
    throw new Error("Invalid server-draft request");
  const saved = deserializeProject(JSON.stringify(parsed.document), assetKinds);
  if (!saved.ok) throw new Error("Invalid document in server-draft request");
  return {
    clientMutationId: parsed.clientMutationId,
    expectedRevision: parsed.expectedRevision,
    document: saved.value,
  };
}

const owner = { projectId: document.projectId, accountId: "autosave-account" };
type SetupOptions = {
  document?: typeof document;
  revision?: number;
  recovery?: ServerSaveSnapshot["serverSave"];
  factory?: IDBFactory;
  initialStorageRevision?: number;
  beforeCheckpoint?: () => Promise<void>;
  respond?: (receipt: Response, attempt: number) => Response | Promise<Response>;
};

async function setup(options: SetupOptions = {}) {
  const writes: { body: string; signal: AbortSignal }[] = [];
  const events = new EventTarget();
  const statuses: ServerSaveStatus[] = [];
  const checkpoints: ServerSaveSnapshot[] = [];
  const database = new IndexedDBDraftDatabase(options.factory ?? new IDBFactory());
  let localRevision = options.initialStorageRevision ?? 0;
  let local = Promise.resolve(true);
  const checkpoint = (snapshot: ServerSaveSnapshot) => {
    checkpoints.push(snapshot);
    local = local.then(async () => {
      await options.beforeCheckpoint?.();
      const result = await applySaveRecoverySession(
        snapshot,
        localRevision,
        assetKinds,
        database,
        owner,
      );
      if (result.ok) localRevision = result.value;
      events.dispatchEvent(new Event("checkpoint"));
      return result.ok;
    });
    return local;
  };
  const server = await serveHttp(async (request) => {
    const { method, url, signal } = request;
    const path = new URL(url).pathname;
    if (method === "GET" && path === "/api/v1/auth/csrf")
      return Response.json({ requestToken: "test-token" });
    if (method !== "PUT" || path !== "/api/v1/projects/" + document.projectId)
      throw new Error("Unexpected autosave request");
    const body = await request.text();
    const attempt = writes.push({ body, signal });
    const parsed = saveBody(body);
    const receipt = Response.json({
      projectId: document.projectId,
      clientMutationId: parsed.clientMutationId,
      revision: parsed.expectedRevision + 1,
    });
    return options.respond?.(receipt, attempt) ?? receipt;
  });
  const session = createServerAutosave({
    document: options.document ?? document,
    revision: options.revision ?? 3,
    assetKinds,
    onStatus(status) {
      statuses.push(status);
      events.dispatchEvent(new Event(status));
    },
    write: (request, signal) => writeServerDraft(request, signal, server.fetch),
    checkpoint,
    ...(options.recovery ? { recovery: options.recovery } : {}),
  });
  async function advanceUntil(ms: number, event: ServerSaveStatus | "checkpoint" = "saved") {
    const reached = once(events, event);
    await vi.advanceTimersByTimeAsync(ms);
    await reached;
  }
  return {
    session,
    writes,
    statuses,
    checkpoints,
    advanceUntil,
    readStored: () => getRecoverySession(assetKinds, database, owner),
  };
}

// Control both the quiet period and maximum delay without waiting on wall-clock time
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

describe("server autosave scheduling", () => {
  it("coalesces edits after two seconds and leaves an unchanged document alone", async () => {
    const { session, writes, statuses, advanceUntil } = await setup();
    // An unchanged document never creates a request or a save timer
    session.changed(document);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(0);
    // A later edit extends the quiet period and replaces the pending snapshot
    session.changed(changed("First"));
    await vi.advanceTimersByTimeAsync(1_000);
    session.changed(changed("Second"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(writes).toHaveLength(0);
    await advanceUntil(1);
    expect(writes).toHaveLength(1);
    expect(saveBody(writes[0]!.body).document.title).toBe("Second");
    expect(statuses.at(-1)).toBe("saved");
    await session.dispose();
  });

  it("saves after five seconds even while edits keep arriving", async () => {
    const { session, writes, advanceUntil } = await setup();
    // Continuous editing must still flush after the maximum delay
    for (let i = 0; i < 5; i += 1) {
      session.changed(changed(`Edit ${i}`));
      if (i === 4) await advanceUntil(1_000);
      else await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(writes).toHaveLength(1);
    await session.dispose();
  });

  it("waits for one request before saving newer edits against its confirmed revision", async () => {
    const received = deferred<void>();
    const release = deferred<void>();
    const { session, writes, statuses, advanceUntil } = await setup({
      respond: async (receipt, attempt) => {
        if (attempt === 1) {
          received.resolve();
          await release.promise;
        }
        return receipt;
      },
    });
    session.changed(changed("First"));
    const firstSave = session.flush();
    await received.promise;
    session.changed(changed("Second"));
    // Manual Save joins the active request and waits for its receipt
    const joinedSave = session.flush();
    expect(joinedSave).toBe(firstSave);
    expect(writes).toHaveLength(1);
    release.resolve();
    await joinedSave;
    expect(statuses.at(-1)).toBe("unsaved");
    await advanceUntil(2_000);
    expect(saveBody(writes[1]!.body).expectedRevision).toBe(4);
    expect(statuses.at(-1)).toBe("saved");
    await session.dispose();
  });

  it("retries identical bytes after a lost response before sending subsequent edits", async () => {
    const { session, writes, advanceUntil } = await setup({
      respond: (receipt, attempt) => (attempt === 1 ? Response.error() : receipt),
    });
    // An uncertain failure keeps the original request bytes and mutation identity

    session.changed(changed("First"));
    await session.flush();
    session.changed(changed("Second"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(1);
    await session.flush();
    expect(writes[1]!.body).toBe(writes[0]!.body);
    await advanceUntil(2_000);
    expect(saveBody(writes[2]!.body).document.title).toBe("Second");
    await session.dispose();
  });

  it("reconciles a lost save receipt while a newer link is unfinished", async () => {
    const { session, writes, advanceUntil } = await setup({
      respond: (receipt, attempt) => (attempt === 1 ? Response.error() : receipt),
    });

    session.changed(changed("Sent before disconnect"));
    await session.flush();
    const original = writes[0]!;
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
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toBe(original.body);
    expect(session.getRecovery().serverSave).toMatchObject({ revision: 4, pending: null });
    expect(session.getRecovery().document).toEqual(draft);
    expect(session.getStatus()).toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(2);
    session.changed(changed("Corrected offline"));
    await advanceUntil(2_000);
    expect(writes).toHaveLength(3);
    const corrected = saveBody(writes[2]!.body);
    expect(corrected.expectedRevision).toBe(4);
    expect(corrected.clientMutationId).not.toBe(saveBody(original.body).clientMutationId);
    expect(corrected.document.title).toBe("Corrected offline");
    expect(session.getStatus()).toBe("saved");
    await session.dispose();
  });

  it.each(["during", "after"] as const)(
    "saves corrections made %s a definite document rejection with a fresh mutation",
    async (timing) => {
      const received = deferred<void>();
      const release = deferred<void>();
      const { session, writes, advanceUntil } = await setup({
        respond: async (receipt, attempt) => {
          if (attempt !== 1) return receipt;
          received.resolve();
          await release.promise;
          return Response.json({ code: "invalid_document" }, { status: 422 });
        },
      });
      session.changed(changed("Rejected content"));
      const saving = session.flush();
      await received.promise;
      const rejected = saveBody(writes[0]!.body);
      if (timing === "during") session.changed(changed("Corrected content"));
      release.resolve();
      await saving;
      expect(session.getRecovery().serverSave).toMatchObject({ revision: 3, pending: null });
      if (timing === "after") {
        expect(session.getStatus()).toBe("invalid");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(writes).toHaveLength(1);
        session.changed(changed("Corrected content"));
      }
      await advanceUntil(2_000);
      expect(writes).toHaveLength(2);
      const corrected = saveBody(writes[1]!.body);
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
      const { session, writes } = await setup({
        respond: () => new Response(null, { status: kind === "conflict" ? 409 : 403 }),
      });

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
      expect(writes).toHaveLength(1);
      expect(session.getStatus()).toBe(kind);
      expect(session.getRecovery().serverSave.pending).not.toBeNull();
      await session.dispose();
    },
  );

  it.each(["conflict", "rejected"] as const)(
    "pauses on %s without overwriting or retrying",
    async (kind) => {
      const { session, writes, statuses } = await setup({
        respond: () => new Response(null, { status: kind === "conflict" ? 409 : 403 }),
      });
      // Conflicts and rejected sessions require an explicit decision before another write

      session.changed(changed("First"));
      await session.flush();
      session.changed(changed("Keep these edits"));
      await session.flush();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(1);
      expect(statuses.at(-1)).toBe(kind);
      await session.dispose();
    },
  );

  it("cancels pending work and ignores late responses after leaving the session", async () => {
    const received = deferred<void>();
    const release = deferred<void>();
    const { session, writes, statuses } = await setup({
      respond: async (receipt, attempt) => {
        if (attempt === 1) {
          received.resolve();
          await release.promise;
        }
        return receipt;
      },
    });
    session.changed(changed("First"));
    const saving = session.flush();
    await received.promise;
    // Leaving aborts the old request and suppresses its late status updates
    const aborted = once(writes[0]!.signal, "abort");
    const disposed = session.dispose();
    const statusCount = statuses.length;
    await aborted;
    expect(writes[0]?.signal.aborted).toBe(true);
    release.resolve();
    await saving;
    await disposed;
    expect(statuses).toHaveLength(statusCount);
    expect(session.changed(changed("After logout"))).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(1);
  });

  it("rejects wrong-project and invalid snapshots before scheduling writes", async () => {
    const { session, writes } = await setup();
    // Neither a different project nor invalid authored data may start a save
    expect(session.changed({ ...document, projectId: crypto.randomUUID() })).toBe(false);
    expect(session.changed({ ...document, scenes: [] })).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toHaveLength(0);
    await session.dispose();
  });
});

describe("server autosave recovery", () => {
  it("preserves edits when the server revision cannot advance further", async () => {
    const { session, writes, checkpoints, readStored } = await setup({
      revision: Number.MAX_SAFE_INTEGER,
    });
    // Preserve the local edit when the revision counter cannot safely increase
    session.changed(changed("Keep this edit"));
    await session.flush();
    expect(writes).toHaveLength(0);
    expect(checkpoints).toHaveLength(1);
    expect(await readStored()).toMatchObject({
      ok: true,
      value: { document: { title: "Keep this edit" } },
    });
    expect(session.getStatus()).toBe("rejected");
    await session.dispose();
  });

  it("reopens an uncertain save with identical bytes before saving newer edits", async () => {
    const factory = new IDBFactory();
    const first = await setup({ factory, respond: () => Response.error() });
    // Preserve the original in-flight snapshot separately from later offline edits
    first.session.changed(changed("Sent before disconnect"));
    await first.session.flush();
    first.session.changed(changed("Edited offline"));
    await first.advanceUntil(2_000, "checkpoint");
    expect(first.writes).toHaveLength(1);
    await first.session.dispose();
    const stored = await first.readStored();
    if (!stored.ok || !stored.value?.document || !stored.value.serverSave?.pending)
      throw new Error("Expected a stored offline edit and pending mutation");
    const snapshot = stored.value;
    const recovery = snapshot.serverSave!;
    const originalPending = recovery.pending!;
    expect(snapshot.document.title).toBe("Edited offline");
    expect(JSON.parse(originalPending.documentJson)).toMatchObject({
      title: "Sent before disconnect",
    });

    // Start a fresh owner using only the stored scene and retry metadata
    // Its first request must still refer to the edit sent before the disconnect
    const {
      session: reopened,
      writes,
      advanceUntil,
      readStored,
    } = await setup({
      factory,
      document: snapshot.document,
      recovery,
      initialStorageRevision: snapshot.revision,
    });
    expect(reopened.getStatus()).toBe("unsaved");
    await reopened.flush();
    // Retry the original mutation before advancing to the later edited document
    expect(writes[0]!.body).toBe(first.writes[0]!.body);
    const replay = saveBody(writes[0]!.body);
    expect(replay.clientMutationId).toBe(originalPending.clientMutationId);
    expect(replay.document.title).toBe("Sent before disconnect");
    expect(replay.expectedRevision).toBe(3);
    expect(reopened.getStatus()).toBe("unsaved");
    await advanceUntil(2_000);
    expect(saveBody(writes[1]!.body)).toMatchObject({
      expectedRevision: 4,
      document: { title: "Edited offline" },
    });
    expect(await readStored()).toMatchObject({
      ok: true,
      value: { serverSave: { pending: null, revision: 5 } },
    });
    expect(reopened.getStatus()).toBe("saved");
    await reopened.dispose();
  });

  it("does not send when the recovery write fails and retries after storage recovers", async () => {
    // Fail the local backup first, then let storage work on the next attempt
    // The server must receive nothing until the retry identity is safely stored
    const factory = new IDBFactory();
    const unsupported = factory.open("vthere-local-drafts", 3);
    await once(unsupported, "success");
    unsupported.result.close();
    const { session, writes, checkpoints } = await setup({ factory });
    session.changed(changed("Keep in memory"));
    await session.flush();
    expect(writes).toHaveLength(0);
    expect(session.getStatus()).toBe("failed");
    // Storage recovery retries the same captured mutation instead of creating a new one
    const mutation = checkpoints[0]!.serverSave.pending!.clientMutationId;
    await once(factory.deleteDatabase("vthere-local-drafts"), "success");
    await session.flush();
    expect(saveBody(writes[0]!.body).clientMutationId).toBe(mutation);
    expect(session.getStatus()).toBe("saved");
    await session.dispose();
  });

  it("backs up edits during a conflict without sending them over the server copy", async () => {
    const { session, writes, checkpoints, readStored, advanceUntil } = await setup({
      respond: () => new Response(null, { status: 409 }),
    });
    session.changed(changed("Conflicting edit"));
    await session.flush();
    session.changed(changed("More local work"));
    // A conflict pauses server writes while local recovery continues accepting edits
    await session.flush();
    await advanceUntil(2_000, "checkpoint");
    expect(writes).toHaveLength(1);
    expect(checkpoints).toHaveLength(2);
    expect(await readStored()).toMatchObject({
      ok: true,
      value: { document: { title: "More local work" } },
    });
    expect(session.getStatus()).toBe("conflict");
    await session.dispose();
  });

  it("cancels before sending if the account changes while recovery storage is busy", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let checkpoints = 0;
    const { session, writes, statuses, readStored } = await setup({
      async beforeCheckpoint() {
        if (++checkpoints !== 1) return;
        started.resolve();
        await release.promise;
      },
    });
    session.changed(changed("Old account"));
    // An account change during the backup cancels the request before network delivery
    const saving = session.flush();
    await started.promise;
    const disposed = session.dispose();
    const count = statuses.length;
    release.resolve();
    await saving;
    await disposed;
    expect(writes).toHaveLength(0);
    expect(statuses).toHaveLength(count);
    expect(await readStored()).toMatchObject({
      ok: true,
      value: { document: { title: "Old account" } },
    });
  });
});
