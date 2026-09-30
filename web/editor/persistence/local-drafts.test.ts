import { describe, expect, it } from "vitest";
import fixture from "../../shared/project/fixtures/m1-project.json";
import { serializeProject } from "../../shared/project/project-serialization";
import { getLocalDraft } from "./local-drafts";
import type { IDraftDatabase } from "./draft-db";
import type { ValidationResult } from "../../shared/project/validation-helpers";

class FakeDraftDatabase implements IDraftDatabase {
    readonly projectIds: string[] = [];
    private readonly result: ValidationResult<unknown>;

    constructor(result: ValidationResult<unknown>) {
        this.result = result;
    }

    async getDraft(projectId: string): Promise<ValidationResult<unknown>> {
        this.projectIds.push(projectId);
        return this.result;
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
        const serialized = serializeProject(fixture, assets);
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) return;
        const database = new FakeDraftDatabase({
            ok: true,
            value: storedDraft(serialized.value),
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

