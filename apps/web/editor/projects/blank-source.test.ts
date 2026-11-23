import { expect, it } from "vitest";
import {
  blankSourceKey,
  blankSourceAttempt,
  readBlankSource,
  historicalBlankSource,
  uncorrelatedBlankSource,
  selectedExistingSource,
  selectExistingSource,
  verifySelectedSource,
  adoptBlankSource,
  adoptedBlankSource,
  clearBlankSource,
  createBlankSource as createGuardedBlankSource,
} from "./blank-source";
import {
  creatorId,
  organizationId,
  fillStorage,
  profileStorage as storage,
  serveCreation,
  readyHead,
} from "../../tests/creation-fixture";
import { createExistingProjectClient } from "../home/existing-project";
import type { EncodedProjectImage } from "./project-image";
const projectId = "aefea67c-caca-4300-923c-937f1c785578";
const created = {
  projectId,
  revision: 0,
  updatedAt: "2026-11-05T00:00:00Z",
  archived: false,
};
const image = { type: "cover" as const, contentType: "image/png", data: "aW1hZ2U=" };

async function sourceApi(
  options: {
    actorId?: string;
    projectId?: string;
    revision?: number;
    unavailable?: boolean;
    readFailed?: boolean;
    create?: () => Response;
    head?: () => Response;
    acknowledge?: () => Response;
  } = {},
) {
  const server = await serveCreation({
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.head ? { head: options.head } : {}),
    write(path) {
      return path.endsWith("/acknowledge")
        ? (options.acknowledge?.() ?? new Response(null, { status: 204 }))
        : (options.create?.() ?? Response.json(created));
    },
    read(path) {
      if (!path.startsWith("/api/v1/projects?")) throw new Error("Unexpected source read");
      if (options.readFailed) return new Response(null, { status: 503 });
      return Response.json({
        items: options.unavailable
          ? []
          : [
              {
                ...created,
                projectId: options.projectId ?? projectId,
                revision: options.revision ?? 0,
                title: "Museum",
                permissions: { canEdit: true, canManage: true, canPublish: true },
              },
            ],
        nextCursor: null,
      });
    },
  });
  return {
    ...server,
    creates: () => server.writes.filter(({ path }) => path === "/api/v1/projects"),
    readSource: (actorId: string, source: string) => readBlankSource(actorId, source, server.fetch),
    verify: createExistingProjectClient(server.fetch).check,
  };
}

type SourceApi = Awaited<ReturnType<typeof sourceApi>>;

function createBlankSource(
  store: ReturnType<typeof storage>,
  server: SourceApi,
  actorId: string,
  title: string,
  environment: string,
  image?: EncodedProjectImage,
) {
  return createGuardedBlankSource(
    store,
    server.write,
    actorId,
    title,
    environment,
    server.readSource,
    image,
    server.read,
  );
}

it("keeps the form retryable when the browser cannot store the first source marker", async () => {
  const store = storage();
  const server = await sourceApi();
  fillStorage();
  const result = await createBlankSource(store, server, creatorId, "Museum", "");
  expect(server.creates()).toHaveLength(0);
  expect(result).toEqual({
    kind: "rejected",
    message:
      "The browser could not save recovery information. Check browser storage and try again.",
  });
});

it("clears only the confirmed assignment's source and preserves a replacement receipt", async () => {
  const actor = creatorId;
  const older = "aefea67c-caca-4300-923c-937f1c785578";
  const replacement = "15c0fbe1-a338-4030-9360-b04c494d6588";
  const store = storage();
  const fresh = JSON.stringify({
    receipt: {
      projectId: replacement,
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  store.setItem(blankSourceKey(actor), fresh);
  expect(await clearBlankSource(store, actor, { projectId: older })).toBe(false);
  expect(store.getItem(blankSourceKey(actor))).toBe(fresh);
  expect(await clearBlankSource(store, actor, { projectId: replacement })).toBe(true);
  expect(store.getItem(blankSourceKey(actor))).toBeNull();
});

it("rechecks a confirmed source and uses its current revision on retry", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = storage();
  store.setItem(blankSourceKey(creatorId), saved);
  const server = await sourceApi({ revision: 3 });
  expect(await createBlankSource(store, server, creatorId, "Museum", "")).toEqual({
    kind: "confirmed",
    projectId: "aefea67c-caca-4300-923c-937f1c785578",
    revision: 3,
  });
  expect(
    server.requests
      .find((request) => new URL(request.url).pathname === "/api/v1/projects")
      ?.headers.get("X-Spatia-Account"),
  ).toBe(creatorId);
  expect(server.creates()).toHaveLength(0);
});

it("preserves the receipt and offers recovery when a source is no longer available", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = storage();
  store.setItem(blankSourceKey(creatorId), saved);
  const server = await sourceApi({ unavailable: true });
  expect(await createBlankSource(store, server, creatorId, "Museum", "")).toEqual({
    kind: "source-unavailable",
  });
  expect(store.getItem(blankSourceKey(creatorId))).toBe(saved);
  expect(server.creates()).toHaveLength(0);
});

it("keeps the receipt when the source cannot be checked temporarily", async () => {
  const saved = JSON.stringify({
    receipt: {
      projectId: "aefea67c-caca-4300-923c-937f1c785578",
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
  });
  const store = storage();
  store.setItem(blankSourceKey(creatorId), saved);
  const server = await sourceApi({ readFailed: true });
  expect(await createBlankSource(store, server, creatorId, "Museum", "")).toMatchObject({
    kind: "rejected",
    message: expect.stringMatching(/could not be checked/i),
  });
  expect(store.getItem(blankSourceKey(creatorId))).toBe(saved);
  expect(server.creates()).toHaveLength(0);
});

it("reuses the confirmed source after an assignment failure instead of creating another", async () => {
  const store = storage();
  const server = await sourceApi();
  const first = await createBlankSource(store, server, creatorId, "Museum", "space");
  const second = await createBlankSource(store, server, creatorId, "Museum", "space");
  expect(first).toEqual({
    kind: "confirmed",
    projectId: "aefea67c-caca-4300-923c-937f1c785578",
    revision: 0,
  });
  expect(second).toEqual(first);
  expect(server.creates()).toHaveLength(1);
});

it("replays the stored source creation operation after an uncertain outcome", async () => {
  const store = storage();
  const server = await sourceApi({ create: () => Response.error() });
  expect(await createBlankSource(store, server, creatorId, "Museum", "space")).toEqual({
    kind: "unknown",
  });
  const key = blankSourceKey(creatorId);
  const stored = store.getItem(key);
  const attempt = blankSourceAttempt(stored ?? "");
  expect(attempt).toEqual({
    operationId: expect.any(String),
    creationGuard: { purpose: "assignment-source", previousOperationId: null },
    title: "Museum",
    environmentAssetId: "space",
  });
  expect(await createBlankSource(store, server, creatorId, "Museum", "space")).toEqual({
    kind: "unknown",
  });
  const write = { actorId: creatorId, path: "/api/v1/projects", method: "POST", body: attempt };
  expect(server.creates()).toEqual([write, write]);
  expect(store.getItem(key)).toBe(stored);
});

it("does not send creation if the recovery marker cannot be verified", async () => {
  const store = storage();
  const storageReplacesWrite = {
    ...store,
    setItem(key: string, value: string) {
      store.setItem(key, value);
      store.setItem(key, "unexpected");
    },
  };
  const server = await sourceApi();
  expect(
    await createBlankSource(storageReplacesWrite, server, creatorId, "Museum", "space"),
  ).toEqual({
    kind: "rejected",
    message: "The browser could not save recovery information.",
  });
  expect(store.getItem(blankSourceKey(creatorId))).toBe("unexpected");
  expect(server.creates()).toHaveLength(0);
});

it("creates an empty source without sending an environment asset", async () => {
  const store = storage();
  const server = await sourceApi();
  const result = await createBlankSource(store, server, creatorId, "Museum", "");
  expect(result.kind).toBe("confirmed");
  expect(server.creates()[0]).toEqual({
    actorId: creatorId,
    path: "/api/v1/projects",
    method: "POST",
    body: {
      title: "Museum",
      operationId: expect.any(String),
      creationGuard: { purpose: "assignment-source", previousOperationId: null },
    },
  });
});

it("sends an image atomically and refuses to reuse a source with a different image", async () => {
  const store = storage();

  const server = await sourceApi();
  expect((await createBlankSource(store, server, creatorId, "Museum", "", image)).kind).toBe(
    "confirmed",
  );
  expect(server.creates()[0]).toEqual({
    actorId: creatorId,
    path: "/api/v1/projects",
    method: "POST",
    body: {
      operationId: expect.any(String),
      creationGuard: { purpose: "assignment-source", previousOperationId: null },
      title: "Museum",
      image,
    },
  });
  expect((await createBlankSource(store, server, creatorId, "Museum", "", image)).kind).toBe(
    "confirmed",
  );
  expect(
    (
      await createBlankSource(store, server, creatorId, "Museum", "", {
        ...image,
        data: "ZGlmZmVyZW50",
      })
    ).kind,
  ).toBe("image-mismatch");
  expect(server.creates()).toHaveLength(1);
  expect(store.getItem(blankSourceKey(creatorId))).not.toContain(image.data);
});

it("does not reuse an image-bearing source when a failed assignment is reopened without an image", async () => {
  const store = storage();

  const server = await sourceApi();
  expect((await createBlankSource(store, server, creatorId, "Museum", "", image)).kind).toBe(
    "confirmed",
  );
  // A rejected assignment retains this confirmed source receipt for the next attempt.
  const readsBefore = server.requests.filter(
    ({ url }) => new URL(url).pathname === "/api/v1/projects" && new URL(url).search,
  ).length;
  const receipt = store.getItem(blankSourceKey(creatorId));
  expect(await createBlankSource(store, server, creatorId, "Museum", "")).toEqual({
    kind: "image-mismatch",
  });
  expect(store.getItem(blankSourceKey(creatorId))).toBe(receipt);
  expect(
    server.requests.filter(
      ({ url }) => new URL(url).pathname === "/api/v1/projects" && new URL(url).search,
    ),
  ).toHaveLength(readsBefore);
  expect(server.creates()).toHaveLength(1);
});

it("retains legacy attempt markers without replaying an operation the server never received", async () => {
  const marker = JSON.stringify({
    attemptId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
    environmentAssetId: "",
  });
  const server = await sourceApi();
  const store = storage();
  store.setItem(blankSourceKey(creatorId), marker);
  expect(await createBlankSource(store, server, creatorId, "Museum", "")).toEqual({
    kind: "unknown",
  });
  expect(server.creates()).toHaveLength(0);
  expect(store.getItem(blankSourceKey(creatorId))).toBe(marker);
});

it("replays a pending source only with identical title and image and keeps the image out of storage", async () => {
  const store = storage();
  const server = await sourceApi({ create: () => Response.error() });
  const image = { type: "cover" as const, contentType: "image/png", data: "secret image" };
  await createBlankSource(store, server, creatorId, "Museum", "", image);
  const marker = store.getItem(blankSourceKey(creatorId));
  expect(marker).not.toContain(image.data);
  expect((await createBlankSource(store, server, creatorId, "Changed", "", image)).kind).toBe(
    "rejected",
  );
  expect((await createBlankSource(store, server, creatorId, "Museum", "")).kind).toBe("rejected");
  expect(server.creates()).toHaveLength(1);
  await createBlankSource(store, server, creatorId, "Museum", "", image);
  expect(server.creates()[1]).toEqual(server.creates()[0]);
  const other = await sourceApi({ actorId: organizationId, create: () => Response.error() });
  await createBlankSource(store, other, organizationId, "Museum", "", image);
  expect(other.creates()).toHaveLength(1);
  expect(other.creates()[0]!.body).not.toEqual(server.creates()[0]!.body);
});

it("does not dispatch or mint a source operation when generation discovery is unsupported", async () => {
  const store = storage();
  const server = await sourceApi({ head: () => new Response(null, { status: 404 }) });
  const result = await createBlankSource(store, server, creatorId, "Museum", "");
  expect(result).toMatchObject({
    kind: "rejected",
    message: expect.stringMatching(/incompatible/),
  });
  expect(server.creates()).toHaveLength(0);
  expect(store.getItem(blankSourceKey(creatorId))).toBeNull();
});

it("replays a pre-generation keyed source exactly without attaching a new creation guard", async () => {
  const store = storage();
  store.setItem(
    blankSourceKey(creatorId),
    JSON.stringify({
      operationId: "11111111-1111-4111-8111-111111111111",
      title: "Museum",
      environmentAssetId: "",
    }),
  );

  const server = await sourceApi({ create: () => Response.error() });
  await createBlankSource(store, server, creatorId, "Museum", "");
  expect(server.creates()).toEqual([
    {
      actorId: creatorId,
      path: "/api/v1/projects",
      method: "POST",
      body: {
        operationId: "11111111-1111-4111-8111-111111111111",
        title: "Museum",
      },
    },
  ]);
  expect(store.getItem(blankSourceKey(creatorId))).not.toContain("creationGuard");
});

it("durably adopts the verified source before acknowledgement and restores it without the image", async () => {
  const actor = creatorId;
  const operationId = "22222222-2222-4222-8222-222222222222";
  const receipt = {
    projectId: "33333333-3333-4333-8333-333333333333",
    revision: 0,
    archived: false,
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const store = storage();

  await adoptBlankSource(store, actor, null, operationId, receipt, {
    projectId: receipt.projectId,
    title: "Adopted source",
    revision: 4,
  });
  const key = blankSourceKey(actor);
  expect(adoptedBlankSource(store.getItem(key)!, actor)).toEqual({
    projectId: receipt.projectId,
    title: "Adopted source",
    revision: 4,
    operationId,
  });
  expect(adoptedBlankSource(store.getItem(key)!, operationId)).toBeNull();
  const server = await sourceApi({
    projectId: receipt.projectId,
    head: () => Response.json({ ...readyHead, operationId }),
  });
  expect(await createBlankSource(store, server, actor, "Assignment", "")).toMatchObject({
    kind: "confirmed",
    projectId: receipt.projectId,
  });
  const acknowledgement = {
    actorId: actor,
    path: "/api/v1/creation-operations/assignment-source/" + operationId + "/acknowledge",
    method: "POST",
    body: {},
  };
  expect(server.writes).toEqual([acknowledgement]);
  const preserved = store.getItem(key);
  expect(preserved).not.toBeNull();
  const outage = await sourceApi({
    projectId: receipt.projectId,
    head: () => Response.json({ state: "unacknowledged", operationId, receipt }),
    acknowledge: () => Response.error(),
  });
  expect(await createBlankSource(store, outage, actor, "Assignment", "")).toEqual({
    kind: "unknown",
  });
  expect(outage.writes).toEqual([acknowledgement]);
  expect(store.getItem(key)).toBe(preserved);
  expect(adoptedBlankSource(store.getItem(key)!, actor)?.projectId).toBe(receipt.projectId);
  expect(await clearBlankSource(store, actor, { projectId: receipt.projectId })).toBe(true);
});

it("never overwrites a changed or different pending source during explicit adoption, and preserves storage failure", async () => {
  const actor = creatorId;
  const operationId = "22222222-2222-4222-8222-222222222222";
  const receipt = {
    projectId: "33333333-3333-4333-8333-333333333333",
    revision: 0,
    archived: false,
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const source = { projectId: receipt.projectId, title: "Source", revision: 0 };
  const original = JSON.stringify({ operationId: actor, title: "Different pending source" });
  const store = storage();
  store.setItem(blankSourceKey(actor), original);
  await expect(adoptBlankSource(store, actor, null, operationId, receipt, source)).rejects.toThrow(
    "changed in another tab",
  );
  await expect(
    adoptBlankSource(store, actor, original, operationId, receipt, source),
  ).rejects.toThrow("different source request");
  expect(store.getItem(blankSourceKey(actor))).toBe(original);
  const unavailable = storage();
  fillStorage();
  await expect(
    adoptBlankSource(unavailable, actor, null, operationId, receipt, source),
  ).rejects.toThrow("preserve the recovered source");
});

it("discards a source selection when its review expires while waiting for the storage lock", async () => {
  const actor = creatorId;
  const operationId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const receipt = { projectId, revision: 0, archived: false, updatedAt: "2026-11-14T00:00:00Z" };
  const store = storage();
  const controller = new AbortController();
  let unlock!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const held = navigator.locks.request(blankSourceKey(actor), async () => {
    acquired();
    await gate;
  });
  await ready;
  const adoption = adoptBlankSource(
    store,
    actor,
    null,
    operationId,
    receipt,
    { projectId, title: "Reviewed", revision: 0 },
    controller.signal,
  );
  controller.abort();
  unlock();
  await held;
  await expect(adoption).rejects.toMatchObject({ name: "AbortError" });
  expect(store.getItem(blankSourceKey(actor))).toBeNull();
});

it("distinguishes an uncorrelated historical attempt from a known receipt and never infers a resource from attemptId", () => {
  const attempt = JSON.stringify({
    attemptId: "11111111-1111-4111-8111-111111111111",
    title: "Museum",
    environmentAssetId: "",
  });
  const receipt = JSON.stringify({
    receipt: {
      projectId: "22222222-2222-4222-8222-222222222222",
      revision: 0,
      archived: false,
      updatedAt: "2026-11-14T00:00:00Z",
    },
  });
  expect(historicalBlankSource(attempt)).toBe(true);
  expect(uncorrelatedBlankSource(attempt)).toBe(true);
  expect(historicalBlankSource(receipt)).toBe(true);
  expect(uncorrelatedBlankSource(receipt)).toBe(false);
  expect(selectedExistingSource(attempt, "actor")).toBeNull();
  for (const value of [
    "{",
    "{}",
    JSON.stringify({
      operationId: "11111111-1111-4111-8111-111111111111",
      title: "Museum",
      environmentAssetId: "",
    }),
  ])
    expect(historicalBlankSource(value)).toBe(false);
});
it("persists explicit existing selection at current revision without creation provenance or ACK and preserves stale-choice failures", async () => {
  const actor = creatorId;
  const source = {
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Equal title",
    revision: 7,
  };
  const store = storage();
  store.setItem(
    blankSourceKey(actor),
    JSON.stringify({
      attemptId: actor,
      title: "Equal title",
      environmentAssetId: "",
    }),
  );
  const original = store.getItem(blankSourceKey(actor));

  const server = await sourceApi({ projectId: source.projectId, revision: 7 });
  const verify = () => server.verify(actor);
  const selected = await selectExistingSource(store, actor, original, source, verify);
  expect(JSON.parse(selected)).toEqual({ actorId: actor, selectedExisting: source });
  expect(selectedExistingSource(selected, actor)).toEqual(source);
  expect(selectedExistingSource(selected, source.projectId)).toBeNull();
  expect(verifySelectedSource(store, actor, selected, source)).toEqual(source);
  expect(await createBlankSource(store, server, actor, "Assignment", "")).toEqual({
    kind: "confirmed",
    projectId: source.projectId,
    revision: 7,
  });
  const newer = await sourceApi({ projectId: source.projectId, revision: 8 });
  expect((await createBlankSource(store, newer, actor, "Assignment", "")).kind).toBe("rejected");
  expect(newer.writes).toHaveLength(0);
  expect(server.creates()).toHaveLength(0);
  expect(store.getItem(blankSourceKey(actor))).toBe(selected);
  store.setItem(
    blankSourceKey(actor),
    JSON.stringify({ actorId: actor, selectedExisting: { ...source, revision: 8 } }),
  );
  expect(() => verifySelectedSource(store, actor, selected, source)).toThrow(
    "changed or was removed",
  );
  await expect(selectExistingSource(store, actor, selected, source, verify)).rejects.toThrow(
    "changed in another tab",
  );
  store.removeItem(blankSourceKey(actor));
  expect(() => verifySelectedSource(store, actor, selected, source)).toThrow(
    "changed or was removed",
  );
});
it("never replaces a modern source operation or unreadable marker with an existing project choice", async () => {
  const actor = creatorId;
  const source = {
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Source",
    revision: 7,
  };
  const server = await sourceApi();
  const verify = () => server.verify(actor);
  for (const record of [
    "{",
    JSON.stringify({ operationId: actor, title: "Pending", environmentAssetId: "" }),
  ]) {
    const store = storage();
    store.setItem(blankSourceKey(actor), record);
    await expect(selectExistingSource(store, actor, record, source, verify)).rejects.toThrow(
      "existing saved source operation",
    );
    expect(store.getItem(blankSourceKey(actor))).toBe(record);
  }
  const known = JSON.stringify({
    receipt: { projectId: actor, revision: 0, archived: false, updatedAt: "2026-11-14T00:00:00Z" },
  });
  const knownStore = storage();
  knownStore.setItem(blankSourceKey(actor), known);
  await expect(selectExistingSource(knownStore, actor, known, source, verify)).rejects.toThrow(
    "receipt identifies a different project",
  );
  expect(knownStore.getItem(blankSourceKey(actor))).toBe(known);
});

it("allows explicit reselection from a valid same-actor manual choice while retaining exact-value CAS", async () => {
  const actor = creatorId;
  const source = { projectId: "22222222-2222-4222-8222-222222222222", title: "First", revision: 7 };
  const replacement = {
    projectId: "33333333-3333-4333-8333-333333333333",
    title: "Second",
    revision: 4,
  };
  const store = storage();

  const server = await sourceApi();
  const verify = () => server.verify(actor);
  const first = await selectExistingSource(store, actor, null, source, verify);
  const second = await selectExistingSource(store, actor, first, replacement, verify);
  expect(selectedExistingSource(second, actor)).toEqual(replacement);
  await expect(selectExistingSource(store, actor, first, source, verify)).rejects.toThrow("Reload");
  expect(store.getItem(blankSourceKey(actor))).toBe(second);
  await expect(
    selectExistingSource(store, actor, second, source, async () => {
      throw new Error("Earlier assignment pending");
    }),
  ).rejects.toThrow("Earlier assignment pending");
  expect(store.getItem(blankSourceKey(actor))).toBe(second);
});
