import { describe, expect, it } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { serializeProject } from "../../shared/project/project-serialization";
import type { ProjectDocument } from "../../shared/project/project-types";
import {
    applySaveRecoverySession,
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
        return this.result ?? {
            ok: true,
            value: this.records.get(`drafts:${JSON.stringify(["local", projectId])}`),
        };
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
                        if (aborted) return;
                        aborted = true;
                        queueMicrotask(() => transaction.onabort?.(new Event("abort")));
                    },
                    objectStore: (name: string) => {
                        if (!names.includes(name)) throw new Error(`Store ${name} was not requested`);
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
                                queueMicrotask(() => transaction.oncomplete?.(new Event("complete")));
                                return resultRequest;
                            },
                            put: (value: unknown, lookup?: IDBValidKey) => {
                                if (mode !== "readwrite") throw new Error("Read-only transaction");
                                const record = value as Record<string, unknown>;
                                const lookupKey: IDBValidKey = lookup ??
                                    (name === "session" ? "active" : [
                                        record.principalKey as string,
                                        record.projectId as string,
                                    ]);
                                this.records.set(key(lookupKey), value);
                                const resultRequest = request(undefined);
                                queueMicrotask(() => transaction.oncomplete?.(new Event("complete")));
                                return resultRequest;
                            },
                            delete: (lookup: IDBValidKey) => {
                                if (mode !== "readwrite") throw new Error("Read-only transaction");
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
                                    result: null as { primaryKey: unknown; value: unknown; continue: () => void } | null,
                                    onsuccess: null as ((event: Event) => void) | null,
                                };
                                let index = 0;
                                const emit = () => {
                                    const entry = entries[index];
                                    cursorRequest.result = entry
                                        ? { primaryKey: entry.key, value: entry.value, continue: () => {
                                            index += 1;
                                            queueMicrotask(emit);
                                        } }
                                        : null;
                                    if (!entry) queueMicrotask(() => transaction.oncomplete?.(new Event("complete")));
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
    if (!serialized.ok) throw new Error("Fixture should serialize");
    return serialized.value;
}

function storedDraftKey(id: string) {
    return `drafts:${JSON.stringify(["local", id])}`;
}

function recoverySession(): Omit<RecoverySession, "revision" | "historyWarning"> {
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
    it("reads and validates the active recovery session", async () => {
        const database = new FakeDraftDatabase();
        database.records.set("session:\"active\"", {
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
    it("saves a new recovery session and increments its revision", async () => {
        const database = new FakeDraftDatabase();

        const result = await applySaveRecoverySession(recoverySession(), 0, assets, database);

        expect(result).toEqual({ ok: true, value: 1 });
        expect(database.records.get("session:\"active\"")).toMatchObject({
            revision: 1,
            fileName: "scene.json",
            document: serializedFixture(),
        });
    });
});

