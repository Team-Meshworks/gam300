import { describe, expect, it } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import contentFixture from "../../shared/project/fixtures/m2-project.json";
import contentCases from "../../shared/project/fixtures/project-format-cases.json";
import { validateServerSaveRecovery } from "./server-save-recovery";
import { serializeProject } from "../../shared/project/project-serialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import {
  applySaveRecoverySession,
  clearConfirmedServerRecovery,
  applySaveToLocalDraft,
  getLatestLocalDraft,
  getLocalDraft,
  getRecoverySession,
  type RecoverySession,
} from "./local-drafts";
import type { IDraftDatabase } from "./draft-db";
import type { ValidationResult } from "../../shared/project/validation-helpers";

class FakeDraftDatabase implements IDraftDatabase {
  readonly projectIds: string[] = [];
  readonly records = new Map<string, unknown>();
  private readonly result: ValidationResult<unknown> | undefined;

  constructor(result?: ValidationResult<unknown>) {
    this.result = result;
  }

  async getDraft(projectId: string): Promise<ValidationResult<unknown>> {
    this.projectIds.push(projectId);
    return (
      this.result ?? {
        ok: true,
        value: this.records.get(`drafts:${JSON.stringify(["local", projectId])}`),
      }
    );
  }

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
              put: (value: unknown, lookup?: IDBValidKey) => {
                if (mode !== "readwrite") {
                  throw new Error("Read-only transaction");
                }
                const record = value as Record<string, unknown>;
                const lookupKey: IDBValidKey =
                  lookup ??
                  (name === "session"
                    ? "active"
                    : [record.principalKey as string, record.projectId as string]);
                this.records.set(key(lookupKey), value);
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
              openCursor: () => {
                const entries = [...this.records.entries()]
                  .filter(([entryKey]) => entryKey.startsWith(`${name}:`))
                  .map(([entryKey, value]) => ({
                    key: JSON.parse(entryKey.slice(name.length + 1)),
                    value,
                  }));
                const cursorRequest = {
                  result: null as {
                    primaryKey: unknown;
                    value: unknown;
                    continue: () => void;
                  } | null,
                  onsuccess: null as ((event: Event) => void) | null,
                };
                let index = 0;
                const emit = () => {
                  const entry = entries[index];
                  cursorRequest.result = entry
                    ? {
                        primaryKey: entry.key,
                        value: entry.value,
                        continue: () => {
                          index += 1;
                          queueMicrotask(emit);
                        },
                      }
                    : null;
                  if (!entry) {
                    queueMicrotask(() => {
                      if (!aborted) {
                        transaction.oncomplete?.(new Event("complete"));
                      }
                    });
                  }
                  cursorRequest.onsuccess?.(new Event("success"));
                };
                queueMicrotask(emit);
                return cursorRequest;
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

function storedDraft(document: string) {
  return {
    projectId,
    principalKey: "local",
    document,
    localStorageRevision: 1,
    localEditSequence: 2,
    baseServerRevision: null,
    pendingMutation: null,
    savedAt: "2026-09-30T00:00:00.000Z",
  };
}

function serializedFixture(project = fixture) {
  const serialized = serializeProject(project, assets);
  expect(serialized.ok).toBe(true);
  if (!serialized.ok) {
    throw new Error("Fixture should serialize");
  }
  return serialized.value;
}

function storedDraftKey(id: string) {
  return `drafts:${JSON.stringify(["local", id])}`;
}

function recoverySession(): Omit<RecoverySession, "revision" | "historyWarning"> & {
  document: ProjectDocument;
} {
  return {
    document: fixture as unknown as ProjectDocument,
    fileName: "scene.json",
    savedJson: null,
    pristine: false,
  };
}

describe("getLocalDraft", () => {
  it("rejects an invalid project ID without reading the database", async () => {
    const database = new FakeDraftDatabase({ ok: true, value: null });

    const result = await getLocalDraft("not-a-uuid", assets, database);

    expect(result).toMatchObject({
      ok: false,
      error: { path: "storage.projectId", message: "Expected a project UUID" },
    });
    expect(database.projectIds).toEqual([]);
  });

  it("normalizes the project ID before querying the database", async () => {
    const database = new FakeDraftDatabase({ ok: true, value: undefined });

    const result = await getLocalDraft(projectId.toUpperCase(), assets, database);

    expect(result).toEqual({ ok: true, value: null });
    expect(database.projectIds).toEqual([projectId]);
  });

  it("forwards a database failure without validating a draft", async () => {
    const failure = {
      ok: false as const,
      error: { path: "storage", message: "Local draft could not be read; try again" },
    };
    const database = new FakeDraftDatabase(failure);

    await expect(getLocalDraft(projectId, assets, database)).resolves.toEqual(failure);
  });

  it("returns null when the database has no draft", async () => {
    const database = new FakeDraftDatabase({ ok: true, value: undefined });

    await expect(getLocalDraft(projectId, assets, database)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("validates and returns a stored draft", async () => {
    const database = new FakeDraftDatabase({
      ok: true,
      value: storedDraft(serializedFixture()),
    });

    const result = await getLocalDraft(projectId, assets, database);

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId,
        localStorageRevision: 1,
        localEditSequence: 2,
        savedAt: "2026-09-30T00:00:00.000Z",
        document: fixture,
      },
    });
  });
});

describe("getLatestLocalDraft", () => {
  it("returns the newest readable local draft", async () => {
    const olderId = "11111111-1111-4111-8111-111111111111";
    const database = new FakeDraftDatabase();
    database.records.set(storedDraftKey(projectId), {
      ...storedDraft(serializedFixture()),
      savedAt: "2026-09-30T00:00:00.000Z",
    });
    database.records.set(storedDraftKey(olderId), {
      ...storedDraft(serializedFixture({ ...fixture, projectId: olderId })),
      projectId: olderId,
      savedAt: "2026-09-29T00:00:00.000Z",
    });

    const result = await getLatestLocalDraft(assets, database);

    expect(result).toMatchObject({ ok: true, value: { projectId } });
  });
});

describe("applySaveToLocalDraft", () => {
  it("saves a new draft and rejects a stale revision", async () => {
    const database = new FakeDraftDatabase();
    const request = {
      project: fixture,
      expectedStorageRevision: 0,
      localEditSequence: 1,
    };

    const saved = await applySaveToLocalDraft(request, assets, database);
    const stale = await applySaveToLocalDraft(request, assets, database);

    expect(saved).toMatchObject({
      ok: true,
      value: { projectId, localStorageRevision: 1, localEditSequence: 1 },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { message: "The local draft changed in another tab; reopen it before saving again" },
    });
  });
});

describe("getRecoverySession", () => {
  it("preserves a richer document as authored work even when its first scene is empty", async () => {
    const database = new FakeDraftDatabase();
    const document = structuredClone(contentFixture);
    // Leave the second scene intact so an empty first scene cannot be mistaken for a disposable new room
    document.scenes[0]!.objects = [];
    document.scenes[0]!.rules = [];
    document.scenes[0]!.groups = [];
    const kinds = new Map(Object.entries(contentCases.assets));
    database.records.set('session:"active"', {
      ...recoverySession(),
      revision: 1,
      document: JSON.stringify(document),
      savedJson: null,
      pristine: true,
    });
    const result = await getRecoverySession(kinds, database);
    expect(result).toMatchObject({ ok: true, value: { pristine: false } });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value?.document?.scenes).toHaveLength(2);
  });
  it("reads and validates the active recovery session", async () => {
    const database = new FakeDraftDatabase();
    database.records.set('session:"active"', {
      ...recoverySession(),
      revision: 3,
      document: serializedFixture(),
    });

    const result = await getRecoverySession(assets, database);

    expect(result).toMatchObject({
      ok: true,
      value: { revision: 3, fileName: "scene.json", document: fixture },
    });
  });
});

describe("applySaveRecoverySession", () => {
  it("keeps New empty after reload and rejects a stale tab's next write", async () => {
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(recoverySession(), 0, assets, database);
    const empty = { document: null, fileName: "", savedJson: null, pristine: true };
    expect(await applySaveRecoverySession(empty, 1, assets, database)).toEqual({
      ok: true,
      value: 2,
    });
    expect(await getRecoverySession(assets, database)).toMatchObject({
      ok: true,
      value: { revision: 2, document: null },
    });
    expect(await applySaveRecoverySession(recoverySession(), 1, assets, database)).toMatchObject({
      ok: false,
    });
    expect(await getRecoverySession(assets, database)).toMatchObject({
      ok: true,
      value: { revision: 2, document: null },
    });
  });

  it("rejects an empty session carrying a previous project's save baseline", async () => {
    const database = new FakeDraftDatabase();
    expect(
      await applySaveRecoverySession({ ...recoverySession(), document: null }, 0, assets, database),
    ).toMatchObject({ ok: false });
    expect(database.records.has('session:"active"')).toBe(false);
  });

  it("saves a new recovery session and increments its revision", async () => {
    const database = new FakeDraftDatabase();

    const result = await applySaveRecoverySession(recoverySession(), 0, assets, database);

    expect(result).toEqual({ ok: true, value: 1 });
    expect(database.records.get('session:"active"')).toMatchObject({
      revision: 1,
      fileName: "scene.json",
      document: serializedFixture(),
    });
  });
});

describe("account-scoped recovery", () => {
  // Same project ID under two accounts catches accidental project-only lookups
  const alice = { accountId: "alice", projectId: fixture.projectId };
  const bob = { accountId: "bob", projectId: fixture.projectId };

  it("keeps each account's copy separate from the local-only session", async () => {
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(recoverySession(), 0, assets, database);
    // A local draft and two signed-in accounts must keep three independent copies
    const aliceSession = { ...recoverySession(), fileName: "alice.json" };
    const bobSession = { ...recoverySession(), fileName: "bob.json" };
    expect(
      await applySaveRecoverySession(aliceSession, 0, assets, database, undefined, alice),
    ).toEqual({ ok: true, value: 1 });
    expect(await applySaveRecoverySession(bobSession, 0, assets, database, undefined, bob)).toEqual(
      { ok: true, value: 1 },
    );
    expect(await getRecoverySession(assets, database, alice)).toMatchObject({
      ok: true,
      value: { fileName: "alice.json" },
    });
    expect(await getRecoverySession(assets, database, bob)).toMatchObject({
      ok: true,
      value: { fileName: "bob.json" },
    });
    expect(await getRecoverySession(assets, database)).toMatchObject({
      ok: true,
      value: { fileName: "scene.json" },
    });
  });

  it("never falls back to another account or the local session when a scoped backup is missing", async () => {
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(recoverySession(), 0, assets, database);
    await applySaveRecoverySession(recoverySession(), 0, assets, database, undefined, alice);
    // A missing scoped key stays empty even when other accounts have saved drafts
    expect(await getRecoverySession(assets, database, bob)).toEqual({ ok: true, value: null });
    expect(
      await getRecoverySession(assets, database, { ...alice, projectId: crypto.randomUUID() }),
    ).toEqual({ ok: true, value: null });
  });

  it("rejects stale writes within the same account and project", async () => {
    const database = new FakeDraftDatabase();
    await applySaveRecoverySession(recoverySession(), 0, assets, database, undefined, alice);
    // Another tab still thinks this record is at revision zero
    // Its write must leave the committed revision-one copy intact
    expect(
      await applySaveRecoverySession(recoverySession(), 0, assets, database, undefined, alice),
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
      await applySaveRecoverySession(recoverySession(), 0, assets, database, undefined, other),
    ).toMatchObject({ ok: false });
    // A corrupted record under the right key still needs its document identity checked
    database.records.set(
      `session:${JSON.stringify(["account", other.accountId, other.projectId])}`,
      {
        ...recoverySession(),
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
      await applySaveRecoverySession(recoverySession(), 0, assets, database, undefined, scope),
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
    expect(await applySaveRecoverySession(session, 0, assets, database, undefined, scope)).toEqual({
      ok: true,
      value: 1,
    });
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({
      ok: true,
      value: { serverSave },
    });
    expect(await applySaveRecoverySession(session, 0, assets, database)).toMatchObject({
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
      undefined,
      scope,
    );
    expect(validateServerSaveRecovery(damaged, projectId, assets).ok).toBe(false);
    expect(
      await applySaveRecoverySession(
        { ...recoverySession(), serverSave: damaged },
        1,
        assets,
        database,
        undefined,
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
      undefined,
      scope,
    );
    expect(await clearConfirmedServerRecovery(scope, database)).toEqual({ ok: true, value: true });
    expect(await getRecoverySession(assets, database, scope)).toEqual({ ok: true, value: null });
    await applySaveRecoverySession(
      { ...recoverySession(), serverSave },
      0,
      assets,
      database,
      undefined,
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
      undefined,
      scope,
    );
    expect(await clearConfirmedServerRecovery(scope, database)).toEqual({ ok: true, value: false });
    expect(await getRecoverySession(assets, database, scope)).toMatchObject({
      ok: true,
      value: { document: { title: "Unsynced" } },
    });
  });
});
