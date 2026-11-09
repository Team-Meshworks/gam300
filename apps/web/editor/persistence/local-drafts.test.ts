import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import contentFixture from "../../shared/project/fixtures/m2-project.json";
import contentCases from "../../shared/project/fixtures/project-format-cases.json";
import { serializeProject } from "../../shared/project/project-serialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import {
  applySaveRecoverySession,
  clearConfirmedServerRecovery,
  getRecoverySession,
  type RecoverySession,
} from "./local-drafts";
import type { IDraftDatabase } from "./draft-db";
import { createDocumentStore } from "../document-store";
import { connectServerProjectSession } from "./server-project-session";
import { validateServerSaveRecovery } from "./server-save-recovery";
import type { ServerDraftRequest, ServerDraftResult } from "./server-draft-write";

afterEach(() => vi.useRealTimers());

// Small IndexedDB stand-in for revision checks and account separation
// Real browser transaction behaviour is checked separately in the browser recovery flow
class FakeDraftDatabase implements IDraftDatabase {
  readonly records = new Map<string, unknown>();

  async getIndexedDB(): Promise<IDBDatabase> {
    const database = {
      transaction: (storeNames: string | string[], mode: IDBTransactionMode) => {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        let aborted = false;
        const transaction = {
          onabort: null as ((event: Event) => void) | null,
          oncomplete: null as ((event: Event) => void) | null,
          error: null as DOMException | null,
          abort: () => {
            if (aborted) {
              return;
            }
            aborted = true;
            queueMicrotask(() => transaction.onabort?.(new Event("abort")));
          },
          objectStore: (name: string) => {
            if (!names.includes(name)) {
              throw new Error(`Store ${name} was not requested`);
            }
            const key = (value: IDBValidKey) => `${name}:${JSON.stringify(value)}`;
            const request = (result: unknown) => {
              // Delay delivery so the caller can attach onsuccess after creating the request
              const resultRequest = {
                result,
                onsuccess: null as ((event: Event) => void) | null,
              };
              queueMicrotask(() => resultRequest.onsuccess?.(new Event("success")));
              return resultRequest;
            };
            return {
              get: (lookup: IDBValidKey) => {
                const resultRequest = request(this.records.get(key(lookup)));

                // Aborted writes cannot also report a successful transaction completion
                queueMicrotask(() => {
                  if (!aborted) {
                    transaction.oncomplete?.(new Event("complete"));
                  }
                });
                return resultRequest;
              },
              put: (value: unknown, lookup: IDBValidKey) => {
                if (mode !== "readwrite") {
                  throw new Error("Read-only transaction");
                }
                this.records.set(key(lookup), value);
                const resultRequest = request(undefined);
                queueMicrotask(() => {
                  if (!aborted) {
                    transaction.oncomplete?.(new Event("complete"));
                  }
                });
                return resultRequest;
              },
              delete: (lookup: IDBValidKey) => {
                if (mode !== "readwrite") {
                  throw new Error("Read-only transaction");
                }
                this.records.delete(key(lookup));
                return request(undefined);
              },
            };
          },
        };
        return transaction;
      },
      close: () => {},
    };
    return database as unknown as IDBDatabase;
  }
}

const assets = new Map([
  ["test-room-v1", "environment"],
  ["test-crate-v1", "model"],
]);
const projectId = fixture.projectId;

function serializedFixture(project = fixture) {
  const serialized = serializeProject(project, assets);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) {
    throw new Error("Fixture should serialize");
  }
  return serialized.value;
}

function recoverySession(): Omit<RecoverySession, "revision" | "historyWarning"> {
  return { document: fixture as unknown as ProjectDocument };
}

describe("account-scoped recovery", () => {
  // Same project ID under two accounts catches accidental project-only lookups
  const alice = { accountId: "alice", projectId: fixture.projectId };
  const bob = { accountId: "bob", projectId: fixture.projectId };

  it("rejects an unscoped recovery read and leaves the former active draft intact", async () => {
    const database = new FakeDraftDatabase();
    const original = {
      fileName: "local.json",
      savedJson: null,
      pristine: false,
      revision: 1,
      document: serializedFixture(),
    };
    database.records.set('session:"active"', original);
    // A stale caller can still omit the scope at runtime.
    expect(await Reflect.apply(getRecoverySession, undefined, [assets, database])).toMatchObject({
      ok: false,
    });
    expect(database.records.get('session:"active"')).toEqual(original);
  });

  it("keeps each account's copy separate from the local-only session", async () => {
    const database = new FakeDraftDatabase();
    const legacy = {
      fileName: "legacy.json",
      document: serializedFixture(),
      revision: 1,
      savedJson: null,
      pristine: false,
    };
    database.records.set('session:"active"', legacy);
    const aliceSession = { document: { ...recoverySession().document, title: "Alice project" } };
    const bobSession = { document: { ...recoverySession().document, title: "Bob project" } };
    expect(await applySaveRecoverySession(aliceSession, 0, assets, database, alice)).toEqual({
      ok: true,
      value: 1,
    });
    expect(await applySaveRecoverySession(bobSession, 0, assets, database, bob)).toEqual({
      ok: true,
      value: 1,
    });
    expect(await getRecoverySession(assets, database, alice)).toMatchObject({
      ok: true,
      value: { document: { title: "Alice project" } },
    });
    expect(await getRecoverySession(assets, database, bob)).toMatchObject({
      ok: true,
      value: { document: { title: "Bob project" } },
    });
    expect(database.records.get('session:"active"')).toEqual(legacy);
  });

  it("never falls back to another account or the local session when a scoped backup is missing", async () => {
    const database = new FakeDraftDatabase();
    database.records.set('session:"active"', { document: serializedFixture() });
    await applySaveRecoverySession(recoverySession(), 0, assets, database, alice);
    // A missing scoped key stays empty even when other accounts have saved drafts
    expect(await getRecoverySession(assets, database, bob)).toEqual({ ok: true, value: null });
    expect(
      await getRecoverySession(assets, database, { ...alice, projectId: crypto.randomUUID() }),
    ).toEqual({ ok: true, value: null });
  });

  it("preserves an invalid scoped older-format record without offering local conversion", async () => {
    const database = new FakeDraftDatabase();
    const older = {
      ...fixture,
      scenes: fixture.scenes.map((scene) => ({
        ...scene,
        hotspots: undefined,
        interactions: undefined,
        viewpoints: [],
      })),
    };
    const original = {
      fileName: "",
      savedJson: null,
      pristine: false,
      revision: 4,
      document: JSON.stringify(older),
    };
    const key = `session:${JSON.stringify(["account", alice.accountId, alice.projectId.toLowerCase()])}`;
    database.records.set(key, original);

    // A malformed authenticated backup never becomes an unscoped import offer for another account
    expect(await getRecoverySession(assets, database, alice)).toMatchObject({ ok: false });
    expect(await getRecoverySession(assets, database, bob)).toEqual({ ok: true, value: null });
    expect(database.records.get(key)).toEqual(original);
  });

  it("rejects stale writes within the same account and project", async () => {
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(recoverySession(), 0, assets, database, alice);
    // Another tab still thinks this record is at revision zero
    // Its write must leave the committed revision-one copy intact
    expect(
      await applySaveRecoverySession(recoverySession(), 0, assets, database, alice),
    ).toMatchObject({ ok: false });
    expect(await getRecoverySession(assets, database, alice)).toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
  });

  it("rejects a different project on both write and recovery", async () => {
    const database = new FakeDraftDatabase();
    const other = { ...alice, projectId: crypto.randomUUID() };
    expect(
      await applySaveRecoverySession(recoverySession(), 0, assets, database, other),
    ).toMatchObject({ ok: false });
    // A corrupted record under the right key still needs its document identity checked
    database.records.set(
      `session:${JSON.stringify(["account", other.accountId, other.projectId])}`,
      {
        fileName: "",
        savedJson: null,
        pristine: false,
        revision: 1,
        document: serializedFixture(),
      },
    );
    expect(await getRecoverySession(assets, database, other)).toMatchObject({ ok: false });
  });

  it("does not treat an empty account as a local-only session", async () => {
    const database = new FakeDraftDatabase();
    // Invalid identity must not silently select the local-only storage key
    const scope = { ...alice, accountId: "" };
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({ ok: false });
    expect(
      await applySaveRecoverySession(recoverySession(), 0, assets, database, scope),
    ).toMatchObject({ ok: false });
    expect(database.records.size).toBe(0);
  });
});

describe("persisted server save identity", () => {
  // Keep the original mutation with the backup so reopening can retry an uncertain save
  const scope = { accountId: "alice", projectId };
  const serverSave = {
    revision: 3,
    confirmedJson: serializedFixture(),
    pending: { clientMutationId: crypto.randomUUID(), documentJson: serializedFixture() },
  };

  it("stores and restores pending save bytes with the edited document", async () => {
    const database = new FakeDraftDatabase();
    // Keep the exact pending request with its document before a retry can occur
    const session = { ...recoverySession(), serverSave };
    expect(await applySaveRecoverySession(session, 0, assets, database, scope)).toEqual({
      ok: true,
      value: 1,
    });
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({
      ok: true,
      value: { serverSave },
    });
    expect(
      await Reflect.apply(applySaveRecoverySession, undefined, [session, 0, assets, database]),
    ).toMatchObject({
      ok: false,
    });
  });

  it.each([
    { ...serverSave, revision: -1 },
    { ...serverSave, pending: { ...serverSave.pending, clientMutationId: "invalid" } },
    { ...serverSave, pending: { ...serverSave.pending, documentJson: "{}" } },
    {
      ...serverSave,
      confirmedJson: serializedFixture({ ...fixture, projectId: crypto.randomUUID() }),
    },
  ])("rejects damaged server metadata without replacing the existing backup", async (damaged) => {
    // Invalid retry metadata must not overwrite the previous valid recovery copy
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(
      { ...recoverySession(), serverSave },
      0,
      assets,
      database,
      scope,
    );
    expect(validateServerSaveRecovery(damaged, projectId, assets).ok).toBe(false);
    expect(
      await applySaveRecoverySession(
        { ...recoverySession(), serverSave: damaged },
        1,
        assets,
        database,
        scope,
      ),
    ).toMatchObject({ ok: false });
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({
      ok: true,
      value: { revision: 1, serverSave },
    });
  });

  it("clears only confirmed cache data and preserves pending or newer local work", async () => {
    // Walk through a confirmed copy, an uncertain request and an unsent edit
    // Only the first record is safe for automatic cleanup
    const database = new FakeDraftDatabase();
    const confirmed = { ...serverSave, pending: null };
    await applySaveRecoverySession(
      { ...recoverySession(), serverSave: confirmed },
      0,
      assets,
      database,
      scope,
    );
    expect(await clearConfirmedServerRecovery(scope, database)).toEqual({ ok: true, value: true });
    expect(await getRecoverySession(assets, database, scope)).toEqual({ ok: true, value: null });
    await applySaveRecoverySession(
      { ...recoverySession(), serverSave },
      0,
      assets,
      database,
      scope,
    );
    expect(await clearConfirmedServerRecovery(scope, database)).toEqual({ ok: true, value: false });
    await applySaveRecoverySession(
      {
        ...recoverySession(),
        document: { ...recoverySession().document, title: "Unsynced" },
        serverSave: confirmed,
      },
      1,
      assets,
      database,
      scope,
    );
    expect(await clearConfirmedServerRecovery(scope, database)).toEqual({ ok: true, value: false });
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({
      ok: true,
      value: { document: { title: "Unsynced" } },
    });
  });
});

describe("server project session lifecycle", () => {
  function setup() {
    // Use the real document store with controlled storage and server replies
    // Events below stand in for browser reconnects and the account owner's logout signal
    vi.useFakeTimers();
    const store = createDocumentStore([]);
    expect(store.loadProject(serializedFixture(), assets).ok).toBe(true);
    const database = new FakeDraftDatabase();
    const account = new AbortController();
    const events = new EventTarget();
    const write = vi
      .fn<(request: ServerDraftRequest, signal: AbortSignal) => Promise<ServerDraftResult>>()
      .mockImplementation(async (request) => {
        const body = JSON.parse(request.body);
        return {
          kind: "saved",
          receipt: {
            projectId,
            clientMutationId: body.clientMutationId,
            revision: body.expectedRevision + 1,
          },
        };
      });
    const onStatus = vi.fn();
    const session = connectServerProjectSession({
      accountId: "alice",
      store,
      revision: 3,
      storageRevision: 0,
      assetKinds: assets,
      signal: account.signal,
      database,
      events,
      write,
      onStatus,
    });
    return { store, database, account, events, write, onStatus, session };
  }

  it.each(["save", "export", "recovery"] as const)(
    "preserves unfinished links and subsequent edits during %s departure",
    async (choice) => {
      const { store, session, database, write } = setup();
      const draft = structuredClone(store.getSnapshot().project!);
      expect(
        store.setInteractions([
          { when: { type: "scene-starts" }, do: { type: "open-link", url: "" } },
        ]).ok,
      ).toBe(true);
      expect(store.deleteObject(draft.scenes[0]!.objects[0]!.id).ok).toBe(true);
      expect(session.getStatus()).not.toBe("saved");
      const exportFile = vi.fn(async () => true);
      const result = await session.prepareToLeave(choice, exportFile);
      expect(result.ok).toBe(choice === "recovery");
      expect(exportFile).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      await session.dispose();
      const recovered = await getRecoverySession(assets, database, {
        accountId: "alice",
        projectId,
      });
      expect(recovered.ok && recovered.value?.document?.scenes[0]?.objects).toHaveLength(
        draft.scenes[0]!.objects.length - 1,
      );
      expect(
        recovered.ok && recovered.value?.document?.scenes[0]?.interactions[0]?.do,
      ).toMatchObject({ url: "" });
    },
  );

  it("keeps cancelled and failed export decisions open, then leaves after confirmed export", async () => {
    const { store, session, write } = setup();
    store.loadProject(serializedFixture({ ...fixture, title: "Unsent work" }), assets);
    expect(await session.prepareToLeave("cancel")).toEqual({ ok: true, value: false });
    expect(await session.prepareToLeave("export", async () => false)).toMatchObject({ ok: false });
    // Export must receive the latest complete document before the session can stop
    const exportFile = vi.fn(async (json: string) => JSON.parse(json).title === "Unsent work");
    expect(await session.prepareToLeave("export", exportFile)).toEqual({ ok: true, value: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
  });

  // An export cannot cover an edit made while the picker is open
  it("refuses to leave when another edit arrives during export", async () => {
    const { store, session } = setup();
    store.loadProject(serializedFixture({ ...fixture, title: "Exported version" }), assets);
    expect(
      await session.prepareToLeave("export", async () => {
        store.loadProject(serializedFixture({ ...fixture, title: "Newer version" }), assets);
        return true;
      }),
    ).toMatchObject({ ok: false });
    expect(session.getStatus()).toBe("unsaved");
    expect(await session.prepareToLeave("save")).toEqual({ ok: true, value: true });
  });

  it("keeps the editor open when recovery storage fails and still permits export", async () => {
    const { store, session, database, write } = setup();
    vi.spyOn(database, "getIndexedDB").mockRejectedValue(new Error("Quota exceeded"));
    store.loadProject(serializedFixture({ ...fixture, title: "Unstored work" }), assets);
    expect(await session.prepareToLeave("recovery")).toMatchObject({ ok: false });
    expect(await session.prepareToLeave("save")).toMatchObject({ ok: false });
    expect(write).not.toHaveBeenCalled();
    // A real completed export remains an escape path when browser storage is unavailable
    expect(await session.prepareToLeave("export", async () => true)).toEqual({
      ok: true,
      value: true,
    });
  });

  // A stale revision remains available as a separate local recovery copy
  it("requires an explicit recovery choice after a server conflict", async () => {
    const { store, session, database, write } = setup();
    write.mockResolvedValue({ kind: "conflict" });
    store.loadProject(serializedFixture({ ...fixture, title: "Conflicting work" }), assets);
    expect(await session.prepareToLeave("save")).toMatchObject({ ok: false });
    expect(session.getStatus()).toBe("conflict");
    expect(await session.prepareToLeave("recovery")).toEqual({ ok: true, value: true });
    expect(
      await getRecoverySession(assets, database, { accountId: "alice", projectId }),
    ).toMatchObject({
      ok: true,
      value: { document: { title: "Conflicting work" } },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  // Reconnection retries the same pending request for server deduplication
  it("backs up committed store edits and retries on reconnect", async () => {
    const { store, database, events, write, session } = setup();
    write.mockResolvedValueOnce({ kind: "failed" });
    store.loadProject(serializedFixture({ ...fixture, title: "Offline edit" }), assets);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.getStatus()).toBe("failed");
    expect(
      await getRecoverySession(assets, database, { accountId: "alice", projectId }),
    ).toMatchObject({
      ok: true,
      value: { document: { title: "Offline edit" }, serverSave: { revision: 3 } },
    });
    events.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].body).toBe(write.mock.calls[0]![0].body);
    expect(session.getStatus()).toBe("saved");
    session.dispose();
  });

  // Logout disconnects editor changes and network events from the old account
  it("removes listeners on logout so the next account cannot retry old work", async () => {
    const { store, account, events, write, onStatus } = setup();
    store.loadProject(serializedFixture({ ...fixture, title: "Alice edit" }), assets);
    account.abort();
    const count = onStatus.mock.calls.length;
    store.loadProject(serializedFixture({ ...fixture, title: "Bob edit" }), assets);
    events.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(count);
  });

  // Reopened history must belong to the recovered document
  it("saves undo changes and keeps their history with the recovery snapshot", async () => {
    const { store, database, write, session } = setup();
    const object = store.getSnapshot().objects[0];
    if (!object) throw new Error("Fixture needs an object");
    expect(store.deleteObject(object.id).ok).toBe(true);
    await session.flush();
    store.undo();
    await session.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(write.mock.calls[1]![0].body).document.scenes[0].objects).toHaveLength(
      fixture.scenes[0]!.objects.length,
    );
    const recovered = await getRecoverySession(assets, database, { accountId: "alice", projectId });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok || !recovered.value) throw new Error("Missing recovery");
    expect(recovered.value.history).toBeDefined();
    const reopened = createDocumentStore([]);
    // Restore into another store so the check cannot reuse history still held in memory
    expect(
      reopened.loadProject(
        JSON.stringify(recovered.value.document),
        assets,
        recovered.value.history,
      ).ok,
    ).toBe(true);
    expect(reopened.getSnapshot().canRedo).toBe(true);
    await session.dispose();
  });

  // Switching projects preserves the previous draft without sending the new project
  it("stops saving when the store switches to a different project", async () => {
    const { store, database, events, write, session } = setup();
    store.loadProject(serializedFixture({ ...fixture, title: "Old project edit" }), assets);
    const object = store.getSnapshot().objects[0];
    if (!object) throw new Error("Fixture needs an object");
    store.deleteObject(object.id);
    store.loadProject(serializedFixture({ ...fixture, projectId: crypto.randomUUID() }), assets);
    events.dispatchEvent(new Event("online"));
    await session.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();
    await session.dispose();
    const recovered = await getRecoverySession(assets, database, { accountId: "alice", projectId });
    if (!recovered.ok || !recovered.value) throw new Error("Missing previous project backup");
    const reopened = createDocumentStore([]);
    expect(
      reopened.loadProject(
        JSON.stringify(recovered.value.document),
        assets,
        recovered.value.history,
      ).ok,
    ).toBe(true);
    expect(reopened.getSnapshot().canUndo).toBe(true);
  });

  // Closing before the timer fires still preserves unsent edits locally
  it("backs up unsynced edits when closing inside the debounce window", async () => {
    const { store, database, write, session } = setup();
    store.loadProject(serializedFixture({ ...fixture, title: "Last edit before closing" }), assets);
    expect(await session.dispose()).toMatchObject({ ok: true, value: false });
    expect(write).not.toHaveBeenCalled();
    expect(
      await getRecoverySession(assets, database, { accountId: "alice", projectId }),
    ).toMatchObject({
      ok: true,
      value: {
        document: { title: "Last edit before closing" },
        serverSave: { pending: null, revision: 3 },
      },
    });
  });

  // Cleanup must not remove another account’s recovery copy
  it("clears the closed session's confirmed cache without touching another account", async () => {
    const { database, session } = setup();
    await applySaveRecoverySession(recoverySession(), 0, assets, database, {
      accountId: "bob",
      projectId,
    });
    expect(await session.dispose()).toMatchObject({ ok: true, value: true });
    expect(await getRecoverySession(assets, database, { accountId: "alice", projectId })).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await getRecoverySession(assets, database, { accountId: "bob", projectId }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
  });
});

it("rejects blank account-scoped recovery without replacing the previous backup", async () => {
  const database = new FakeDraftDatabase();
  const scope = { accountId: "student-a", projectId: fixture.projectId };
  const empty = { document: null, fileName: "", savedJson: null, pristine: true };
  expect(
    await Reflect.apply(applySaveRecoverySession, undefined, [empty, 0, assets, database, scope]),
  ).toMatchObject({ ok: false });
  expect(database.records.size).toBe(0);

  // Stored data is untrusted too; reject an invalid scoped blank record on read
  database.records.set(
    `session:${JSON.stringify(["account", scope.accountId, scope.projectId.toLowerCase()])}`,
    { ...empty, revision: 1 },
  );
  expect(await getRecoverySession(assets, database, scope)).toMatchObject({ ok: false });
  expect(database.records.size).toBe(1);
});

it.each([1, 2])(
  "recovers incomplete v%s links, corrected edits, and preserves revision conflicts",
  async (version) => {
    const database = new FakeDraftDatabase();
    const kinds = new Map(Object.entries(contentCases.assets));
    const document = structuredClone(
      version === 1 ? fixture : contentFixture,
    ) as unknown as ProjectDocument;
    const draft = {
      ...document,
      scenes: document.scenes.map((scene, index) =>
        index
          ? scene
          : {
              ...scene,
              interactions: [
                {
                  when: { type: "scene-starts" as const },
                  do: { type: "open-link" as const, url: "" },
                },
              ],
            },
      ),
    } as ProjectDocument;
    const scope = { accountId: "alice", projectId: draft.projectId };
    const session = { document: draft };
    expect(serializeProject(draft, kinds).ok).toBe(false);
    expect(await applySaveRecoverySession(session, 0, kinds, database, scope)).toEqual({
      ok: true,
      value: 1,
    });
    const restored = await getRecoverySession(kinds, database, scope);
    expect(restored.ok).toBe(true);
    if (!restored.ok || !restored.value?.document) throw new Error("Missing draft");
    expect(restored.value.document.scenes[0]!.interactions).toEqual(draft.scenes[0]!.interactions);
    const corrected = {
      ...draft,
      title: "Continued editing",
      scenes: draft.scenes.map((scene, index) =>
        index
          ? scene
          : {
              ...scene,
              interactions: [
                {
                  when: { type: "scene-starts" as const },
                  do: { type: "open-link" as const, url: "https://example.com/corrected" },
                },
              ],
            },
      ),
    } as ProjectDocument;
    expect(serializeProject(corrected, kinds).ok).toBe(true);
    expect(
      await applySaveRecoverySession(
        { ...session, document: corrected },
        1,
        kinds,
        database,
        scope,
      ),
    ).toEqual({ ok: true, value: 2 });
    expect((await applySaveRecoverySession(session, 1, kinds, database, scope)).ok).toBe(false);
    const final = await getRecoverySession(kinds, database, scope);
    expect(final.ok && final.value?.document?.title).toBe("Continued editing");
  },
);
