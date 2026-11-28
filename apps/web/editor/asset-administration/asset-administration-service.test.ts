import { afterEach, beforeEach, expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { createAssetAdministrationService } from "./asset-administration-service";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

async function withoutPlatformProperty(owner: object, key: string, run: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !Reflect.deleteProperty(owner, key)) {
    throw new Error(`Could not remove platform property ${key}`);
  }
  try {
    await run();
  } finally {
    Object.defineProperty(owner, key, descriptor);
  }
}
const actor = "11111111-1111-4111-8111-111111111111";
// Keep a valid confirmed record so each case can isolate one HTTP-boundary failure
const candidate = {
  id: "asset-1",
  name: "Crate",
  kind: "model",
  category: "Objects",
  status: "approved",
  hidden: false,
  deleted: false,
  removedFromProjects: false,
  thumbnail: null,
  validation: [],
  actions: ["hide", "delete"],
};

it("sends provenance with the model before automatic availability", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "token" }),
    Response.json(candidate),
  );
  const review = { source: "Museum archive", license: "CC BY 4.0", reviewNotes: "Rights checked" };
  const file = new File(["model"], "crate.glb", { type: "model/gltf-binary" });
  await createAssetAdministrationService(actor, http.fetch).submit(
    { file, kind: "model", category: "Objects", review },
    new AbortController().signal,
  );
  const encoded = http.requests[1]?.headers.get("X-Spatia-Asset-Metadata");
  expect(encoded).not.toBeNull();
  expect(
    JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded!), (c) => c.charCodeAt(0)))),
  ).toEqual(review);
  expect(await http.requests[1]!.bytes()).toEqual(new Uint8Array(await file.arrayBuffer()));
});

it.each([
  [`/api/v1/admin/assets/${actor}/bytes`, true],
  [`/api/admin/assets/${actor}/bytes`, false],
  [`/api/v2/admin/assets/${actor}/bytes`, false],
  [`https://elsewhere.test/api/v1/admin/assets/${actor}/bytes`, false],
])("validates the version and origin of inspection URL %s", async (inspectionUrl, accepted) => {
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;
    return Response.json(
      url === "/api/v1/auth/csrf"
        ? { requestToken: "current-token" }
        : { ...candidate, id: actor, inspectionUrl },
    );
  });
  const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
    actor,
    "hide",
    new AbortController().signal,
  );
  expect(result.ok).toBe(accepted);
});

it.each([
  ["a".repeat(64), true],
  ["A".repeat(64), true],
  ["invalid", false],
  [null, false],
])(
  "validates the content hash used to identify generated previews: %s",
  async (sha256, accepted) => {
    const http = await serveHttp((incoming) => {
      const url = new URL(incoming.url).pathname;
      return Response.json(
        url === "/api/v1/auth/csrf"
          ? { requestToken: "current-token" }
          : {
              ...candidate,
              id: actor,
              sha256,
              inspectionUrl: `/api/v1/admin/assets/${actor}/bytes`,
            },
      );
    });
    const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
      actor,
      "hide",
      new AbortController().signal,
    );
    expect(result.ok).toBe(accepted);
    if (result.ok) expect(result.value.sha256).toBe(sha256);
  },
);

it("deletes an asset from the catalogue without removing it from projects", async () => {
  const assetId = "22222222-2222-4222-8222-222222222222";
  const deleted = { ...candidate, id: assetId, hidden: true, deleted: true, actions: ["remove"] };
  const http = await serveResponses(
    Response.json({ requestToken: "current-token" }),
    Response.json(deleted),
  );
  const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
    assetId,
    "delete",
    new AbortController().signal,
  );
  expect(result).toEqual({ ok: true, value: deleted });
  expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/v1/auth/csrf",
    `/api/v1/admin/assets/${assetId}/availability`,
  ]);
  const change = http.requests[1]!;
  expect(change.method).toBe("POST");
  expect(change.credentials).toBe("same-origin");
  for (const { headers } of http.requests) {
    expect(headers.get("X-Spatia-Account")).toBe(actor);
  }
  expect(change.headers.get("X-CSRF-TOKEN")).toBe("current-token");
  expect(await change.json()).toEqual({
    action: "delete",
    removeFromProjects: false,
  });
});

it("keeps denial, unavailable removal and malformed server responses distinct from success", async () => {
  // Permission loss and unavailable removal must leave the caller outside the success branch
  for (const status of [403, 503]) {
    const http = await serveHttp(() => new Response(null, { status }));
    const result = await createAssetAdministrationService(actor, http.fetch).load(
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, kind: status === 403 ? "denied" : "unavailable" });
  }
  // A partial policy must not enable a screen even when the candidate itself is well formed
  const http = await serveHttp(() =>
    Response.json({ assets: [candidate], policy: { canForceRemove: true } }),
  );
  expect(
    await createAssetAdministrationService(actor, http.fetch).load(new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unavailable" });
});

it("binds catalogue reads, downloads and writes to the original account", async () => {
  const http = await serveResponses(
    new Response(null, { status: 403 }),
    new Response(null, { status: 403 }),
    new Response(null, { status: 403 }),
    new Response(new Uint8Array([1, 2, 3])),
    new Response(null),
  );

  const service = createAssetAdministrationService(actor, http.fetch);
  expect(await service.load(new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "denied",
  });
  expect(http.requests[0]?.headers.get("X-Spatia-Account")).toBe(actor);
  expect(
    await service.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "denied" });
  expect(http.requests).toHaveLength(2);
  expect(new URL(http.requests[1]!.url).pathname).toBe("/api/v1/auth/csrf");

  // A denied download leaves the dialog open instead of navigating to a problem response
  expect(await service.download(actor, new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "denied",
  });
  const download = http.requests[2]!;
  expect(new URL(download.url).pathname).toBe(`/api/v1/admin/assets/${actor}/bytes`);
  expect(download.headers.get("X-Spatia-Account")).toBe(actor);
  expect(download).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(download.signal).toBeInstanceOf(AbortSignal);

  // Download the exact returned bytes while an empty response remains a visible failure
  const downloaded = await service.download(actor, new AbortController().signal);
  expect(downloaded.ok).toBe(true);
  if (downloaded.ok) {
    expect(new Uint8Array(await downloaded.value.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  }
  expect(await service.download(actor, new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "unavailable",
  });
});

it("submits M4A audio with its MIME, category and captured account", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "token" }),
    Response.json({ ...candidate, kind: "audio", category: "BGM" }),
  );
  const file = new File(["audio"], "music.m4a", { type: "audio/mp4" });
  const result = await createAssetAdministrationService(actor, http.fetch).submit(
    {
      file,
      kind: "audio",
      category: "BGM",
      review: { source: "", license: "", reviewNotes: "" },
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  const upload = http.requests[1]!;
  const { pathname, search } = new URL(upload.url);
  expect(pathname + search).toBe("/api/v1/admin/assets?name=music.m4a&kind=audio&category=BGM");
  expect(await upload.bytes()).toEqual(new Uint8Array(await file.arrayBuffer()));
  expect(upload.headers.get("Content-Type")).toBe("audio/mp4");
  expect(upload.headers.get("X-Spatia-Account")).toBe(actor);
});

it.each([
  [[".glb"], undefined, true],
  [[".glb", ".m4a"], ["BGM"], true],
  [[".glb", ".m4a"], undefined, false],
  [[".glb", ".mp3"], ["BGM"], false],
])("validates the deployed audio policy %j", async (extensions, audio, accepted) => {
  const http = await serveHttp(() =>
    Response.json({
      assets: [{ ...candidate, kind: "audio", category: "BGM" }],
      policy: {
        extensions,
        maxBytes: 20 * 1024 * 1024,
        canSubmit: true,
        canForceRemove: true,
        categories: { environment: null, model: ["Objects"], audio },
      },
    }),
  );
  expect(
    (await createAssetAdministrationService(actor, http.fetch).load(new AbortController().signal))
      .ok,
  ).toBe(accepted);
});

it.each([true, "yes"])("validates per-kind upload availability %j", async (audio) => {
  const http = await serveHttp(() =>
    Response.json({
      assets: [],
      policy: {
        extensions: [".glb", ".m4a"],
        maxBytes: 20 * 1024 * 1024,
        canSubmit: false,
        canSubmitByKind: { model: false, environment: false, audio },
        canForceRemove: true,
        categories: { environment: null, model: ["Objects"], audio: ["BGM"] },
      },
    }),
  );
  const result = await createAssetAdministrationService(actor, http.fetch).load(
    new AbortController().signal,
  );
  expect(result.ok).toBe(typeof audio === "boolean");
  if (result.ok) expect(result.value.policy.canSubmitByKind?.audio).toBe(true);
});

it.each([
  ["csrf", "unavailable"],
  ["rejected", "unavailable"],
  ["lost", "unknown"],
  ["gateway", "unknown"],
  ["malformed", "unknown"],
])("distinguishes %s from a confirmed asset upload", async (failure, expected) => {
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") {
      if (failure === "csrf") return Response.error();
      return Response.json({ requestToken: "token" });
    }
    if (failure === "lost") return Response.error();
    if (failure === "gateway") return new Response(null, { status: 502 });
    if (failure === "rejected")
      return Response.json({ code: "asset_intake_unavailable" }, { status: 503 });
    return Response.json({});
  });
  const result = await createAssetAdministrationService(actor, http.fetch).submit(
    {
      file: new File(["model"], "crate.glb"),
      kind: "model",
      category: "Objects",
      review: { source: "", license: "", reviewNotes: "" },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, kind: expected });
});

it.each([401, 403])("distinguishes asset %s preflight and dispatched responses", async (status) => {
  let preflight = true;
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf")
      return preflight ? new Response(null, { status }) : Response.json({ requestToken: "token" });
    return new Response(null, { status });
  });
  const service = createAssetAdministrationService(actor, http.fetch);
  const run = () =>
    service.changeAvailability("asset", "remove", new AbortController().signal, true);
  expect(await run()).toMatchObject({ ok: false, kind: "denied" });
  expect(http.requests.map(({ method }) => method)).toEqual(["GET"]);
  preflight = false;
  expect(await run()).toMatchObject({ ok: false, kind: status === 401 ? "unknown" : "denied" });
  expect(http.requests.map(({ method }) => method)).toEqual(["GET", "GET", "PUT"]);
});

it("retains a legacy uncertain write across service reentry until an authorized catalogue load", async () => {
  let writes = 0;
  let catalogAllowed = false;
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
    if (incoming.method !== "GET") {
      writes++;
      return new Response(null, { status: 401 });
    }
    if (!catalogAllowed) return new Response(null, { status: 401 });
    return Response.json({
      assets: [candidate],
      policy: {
        extensions: [".glb"],
        maxBytes: 1000,
        canSubmit: true,
        canForceRemove: true,
        categories: { environment: null, model: ["Objects"] },
      },
    });
  });
  const signal = new AbortController().signal;
  const first = createAssetAdministrationService(actor, http.fetch);
  expect(await first.changeAvailability("asset", "hide", signal)).toMatchObject({
    kind: "unknown",
  });
  const reopened = createAssetAdministrationService(actor, http.fetch);
  expect(await reopened.changeAvailability("asset", "hide", signal)).toMatchObject({
    kind: "unknown",
  });
  expect(writes).toBe(1);
  expect((await reopened.load(signal)).ok).toBe(false);
  expect(await reopened.changeAvailability("asset", "hide", signal)).toMatchObject({
    kind: "unknown",
  });
  expect(writes).toBe(1);
  catalogAllowed = true;
  expect((await reopened.load(signal)).ok).toBe(true);
  await reopened.changeAvailability("asset", "hide", signal);
  expect(writes).toBe(2);
});

it("serializes concurrent asset writes before either can bypass the recovery fence", async () => {
  let writes = 0;
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
    if (incoming.method !== "GET") {
      writes++;
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 401 });
  });
  const signal = new AbortController().signal;
  const first = createAssetAdministrationService(actor, http.fetch);
  const second = createAssetAdministrationService(actor, http.fetch);
  await Promise.all([
    first.changeAvailability("asset", "remove", signal, true),
    second.changeAvailability("asset", "remove", signal, true),
  ]);
  expect(writes).toBe(1);
});

it("does not dispatch an asset removal when the recovery marker cannot be stored", async () => {
  localStorage.setItem("q", "x".repeat(5 * 1024 * 1024 - 1));
  const http = await serveHttp(() => Response.json({ requestToken: "token" }));

  const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
    "asset",
    "remove",
    new AbortController().signal,
    true,
  );
  expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  expect(http.requests).toHaveLength(1);
});

it("allows read-only catalogue access without browser coordination or storage", async () => {
  const http = await serveResponses(Response.json(catalogue));
  const service = createAssetAdministrationService(actor, http.fetch);
  await withoutPlatformProperty(Reflect.getPrototypeOf(navigator)!, "locks", async () => {
    await withoutPlatformProperty(globalThis, "localStorage", async () => {
      expect((await service.load(new AbortController().signal)).ok).toBe(true);
      expect(
        await service.changeAvailability("asset", "remove", new AbortController().signal, true),
      ).toMatchObject({ ok: false, kind: "unavailable" });
    });
  });
  expect(http.requests).toHaveLength(1);
});

it("rejects an empty CSRF token before dispatching an asset write", async () => {
  const http = await serveHttp(() => Response.json({ requestToken: "" }));

  const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
    "asset",
    "remove",
    new AbortController().signal,
    true,
  );
  expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  expect(http.requests).toHaveLength(1);
});

it("does not clear a pending asset marker when displaying a catalogue without locks", async () => {
  const key = `spatia.asset-write:${actor}`;
  localStorage.setItem(key, "pending");
  const http = await serveResponses(Response.json(catalogue));
  await withoutPlatformProperty(Reflect.getPrototypeOf(navigator)!, "locks", async () => {
    expect(
      (await createAssetAdministrationService(actor, http.fetch).load(new AbortController().signal))
        .ok,
    ).toBe(true);
  });
  expect(localStorage.getItem(key)).toBe("pending");
});

it("allows catalogue reads when storage fails even if browser locks exist", async () => {
  const http = await serveResponses(Response.json(catalogue));
  const service = createAssetAdministrationService(actor, http.fetch);
  await withoutPlatformProperty(globalThis, "localStorage", async () => {
    expect((await service.load(new AbortController().signal)).ok).toBe(true);
    expect(
      await service.changeAvailability("asset", "remove", new AbortController().signal, true),
    ).toMatchObject({ ok: false, kind: "unavailable" });
  });
  expect(http.requests).toHaveLength(1);
});

it("does not settle a keyed removal from a stale authorized catalogue", async () => {
  const key = `spatia.asset-write:${actor}`;
  const marker = JSON.stringify({
    assetId: candidate.id,
    operationId: "22222222-2222-4222-8222-222222222222",
  });
  localStorage.setItem(key, marker);
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
    if (url.endsWith("/reconcile")) return new Response(null, { status: 503 });
    return Response.json({
      assets: [candidate],
      policy: {
        extensions: [".glb"],
        maxBytes: 1000,
        canSubmit: true,
        canForceRemove: true,
        categories: { environment: null, model: ["Objects"] },
      },
    });
  });

  const reopened = createAssetAdministrationService(actor, http.fetch);
  const result = await reopened.load(new AbortController().signal);
  expect(localStorage.getItem(key)).toBe(marker);
  expect(result.ok).toBe(false);
  expect(
    await reopened.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unknown" });
});

const operationId = "22222222-2222-4222-8222-222222222222";
const recoveryKey = `spatia.asset-write:${actor}`;
const removalMarker = JSON.stringify({ assetId: candidate.id, operationId });
const removedCandidate = {
  ...candidate,
  hidden: true,
  deleted: true,
  removedFromProjects: true,
  actions: [],
};
const catalogue = {
  assets: [candidate],
  policy: {
    extensions: [".glb"],
    maxBytes: 1000,
    canSubmit: true,
    canForceRemove: true,
    categories: { environment: null, model: ["Objects"] },
  },
};
it("explains retained quota exhaustion and clears the rejected upload marker", async () => {
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;
    return url === "/api/v1/auth/csrf"
      ? Response.json({ requestToken: "token" })
      : Response.json({ code: "asset_quota_exceeded" }, { status: 409 });
  });
  const result = await createAssetAdministrationService(actor, http.fetch).submit(
    {
      file: new File(["model"], "crate.glb"),
      kind: "model",
      category: "Objects",
      review: { source: "", license: "", reviewNotes: "" },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    ok: false,
    kind: "invalid",
    message: expect.stringContaining("operator"),
  });
  expect(localStorage.getItem(recoveryKey)).toBeNull();
});

it.each(["hide", "remove"] as const)(
  "retains reconciliation after committed %s without a representation",
  async (action) => {
    const http = await serveHttp((incoming) => {
      const url = new URL(incoming.url).pathname;
      return url === "/api/v1/auth/csrf"
        ? Response.json({ requestToken: "token" })
        : new Response(null, { status: 204, headers: { "X-Spatia-Write-Outcome": "committed" } });
    });
    const result = await createAssetAdministrationService(actor, http.fetch).changeAvailability(
      candidate.id,
      action,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, kind: "unknown" });
    expect(localStorage.getItem(recoveryKey)).not.toBeNull();
  },
);

it.each([false, true])(
  "records a keyed removal under its actor lock before dispatch (opt-in %s)",
  async (optIn) => {
    const http = await serveHttp(async (incoming) => {
      const url = new URL(incoming.url).pathname;

      expect(incoming.headers.get("X-Spatia-Account")).toBe(actor);
      if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      const saved = JSON.parse(localStorage.getItem(recoveryKey)!);
      expect(saved.assetId).toBe(candidate.id);
      expect(saved.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await navigator.locks.query()).held?.some((lock) => lock.name === recoveryKey)).toBe(
        true,
      );
      expect(url).toBe(`/api/v1/admin/assets/${candidate.id}/removals/${saved.operationId}`);
      expect(incoming.method).toBe("PUT");
      expect(await incoming.text()).toBe("{}");
      expect(incoming.headers.get("X-CSRF-TOKEN")).toBe("token");
      expect(incoming.headers.get("Prefer")).toBe("spatia-created-status");
      return Response.json(removedCandidate, {
        status: optIn ? 201 : 200,
        headers: { "X-Spatia-Operation-Id": saved.operationId },
      });
    });

    expect(
      await createAssetAdministrationService(actor, http.fetch).changeAvailability(
        candidate.id,
        "remove",
        new AbortController().signal,
        optIn,
      ),
    ).toEqual({ ok: true, value: removedCandidate });
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.credentials).toBe("same-origin");
  },
);

it.each([
  ["missing acknowledgement", removedCandidate, null, 200],
  ["wrong acknowledgement", removedCandidate, operationId, 200],
  ["wrong asset", { ...removedCandidate, id: "another" }, "match", 200],
  ["not removed", { ...removedCandidate, removedFromProjects: false }, "match", 200],
  ["not hidden", { ...removedCandidate, hidden: false }, "match", 200],
  ["not deleted", { ...removedCandidate, deleted: false }, "match", 200],
  ["malformed candidate", {}, "match", 200],
  ["noncanonical success", removedCandidate, "match", 202],
])("retains keyed recovery after %s", async (_name, value, acknowledgement, status) => {
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
    const saved = JSON.parse(localStorage.getItem(recoveryKey)!);
    return Response.json(value, {
      status,
      ...(acknowledgement
        ? {
            headers: {
              "X-Spatia-Operation-Id":
                acknowledgement === "match" ? saved.operationId : acknowledgement,
            },
          }
        : {}),
    });
  });
  const service = createAssetAdministrationService(actor, http.fetch);
  expect(
    await service.changeAvailability(candidate.id, "remove", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unknown" });
  const saved = localStorage.getItem(recoveryKey);
  expect(saved).not.toBeNull();
  expect(
    await service.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unknown" });
  expect(localStorage.getItem(recoveryKey)).toBe(saved);
});

it.each(["removed", "notApplied"])(
  "reconciles %s before reading and settling the fresh catalogue",
  async (outcome) => {
    localStorage.setItem(recoveryKey, removalMarker);
    let settled = false;
    const freshCatalogue = { ...catalogue, assets: [removedCandidate] };
    const http = await serveHttp(async (incoming) => {
      const url = new URL(incoming.url).pathname;

      expect(localStorage.getItem(recoveryKey)).toBe(removalMarker);
      expect(incoming.headers.get("X-Spatia-Account")).toBe(actor);
      if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      if (url.endsWith("/reconcile")) {
        expect(url).toBe(`/api/v1/admin/assets/${candidate.id}/removals/${operationId}/reconcile`);
        expect(incoming.method).toBe("POST");
        expect(await incoming.text()).toBe("{}");
        expect(incoming.headers.get("X-CSRF-TOKEN")).toBe("token");
        settled = true;
        return Response.json({ assetId: candidate.id, operationId, outcome });
      }
      expect(settled).toBe(true);
      return Response.json(settled ? freshCatalogue : catalogue);
    });

    expect(
      await createAssetAdministrationService(actor, http.fetch).load(new AbortController().signal),
    ).toEqual({ ok: true, value: freshCatalogue });
    expect(localStorage.getItem(recoveryKey)).toBeNull();
    expect(http.requests[1]?.credentials).toBe("same-origin");
    expect(http.requests[2]?.cache).toBe("no-store");
    expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/auth/csrf",
      `/api/v1/admin/assets/${candidate.id}/removals/${operationId}/reconcile`,
      "/api/v1/admin/assets",
    ]);
  },
);

it.each([
  ["denied", null, 403],
  ["unauthenticated", null, 401],
  ["unavailable", null, 503],
  ["old server", null, 404],
  ["wrong asset", { assetId: "another", operationId, outcome: "removed" }, 200],
  ["wrong operation", { assetId: candidate.id, operationId: actor, outcome: "removed" }, 200],
  ["invalid outcome", { assetId: candidate.id, operationId, outcome: "pending" }, 200],
  ["missing fields", {}, 200],
  ["noncanonical success", { assetId: candidate.id, operationId, outcome: "removed" }, 201],
])("does not settle a keyed removal after %s reconciliation", async (_name, value, status) => {
  localStorage.setItem(recoveryKey, removalMarker);
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;
    return url === "/api/v1/auth/csrf"
      ? Response.json({ requestToken: "token" })
      : Response.json(value, { status });
  });

  const service = createAssetAdministrationService(actor, http.fetch);
  expect((await service.load(new AbortController().signal)).ok).toBe(false);
  expect(localStorage.getItem(recoveryKey)).toBe(removalMarker);
  expect(
    await service.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unknown" });
  expect(http.requests.map(({ url }) => new URL(url).pathname)).not.toContain(
    "/api/v1/admin/assets",
  );
});

it.each(["denied", "unavailable", "invalid", "lost"])(
  "keeps a reconciled marker when the fresh catalogue is %s",
  async (failure) => {
    localStorage.setItem(recoveryKey, removalMarker);
    const http = await serveHttp((incoming) => {
      const url = new URL(incoming.url).pathname;

      if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      if (url.endsWith("/reconcile"))
        return Response.json({ assetId: candidate.id, operationId, outcome: "removed" });
      if (failure === "lost") return Response.error();
      return Response.json(
        {},
        { status: failure === "denied" ? 403 : failure === "unavailable" ? 503 : 200 },
      );
    });
    expect(
      (await createAssetAdministrationService(actor, http.fetch).load(new AbortController().signal))
        .ok,
    ).toBe(false);
    expect(localStorage.getItem(recoveryKey)).toBe(removalMarker);
  },
);

it("recovers a dispatched removal after browser cancellation and late server commit", async () => {
  const controller = new AbortController();
  let saved: { assetId: string; operationId: string } | undefined;
  let committed = false;
  const http = await serveHttp((incoming) => {
    const url = new URL(incoming.url).pathname;

    if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
    if (incoming.method === "PUT") {
      saved = JSON.parse(localStorage.getItem(recoveryKey)!);
      controller.abort();
      return Response.error();
    }
    if (url.endsWith("/reconcile")) {
      committed = true;
      return Response.json({ ...saved, outcome: "removed" });
    }
    expect(committed).toBe(true);
    return Response.json({ ...catalogue, assets: [removedCandidate] });
  });
  await expect(
    createAssetAdministrationService(actor, http.fetch).changeAvailability(
      candidate.id,
      "remove",
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(JSON.parse(localStorage.getItem(recoveryKey)!)).toEqual(saved);
  const reopened = createAssetAdministrationService(actor, http.fetch);
  expect(
    await reopened.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unknown" });
  expect((await reopened.load(new AbortController().signal)).ok).toBe(true);
  expect(localStorage.getItem(recoveryKey)).toBeNull();
});

it("does not dispatch or record a removal cancelled during security preflight", async () => {
  const controller = new AbortController();
  const http = await serveHttp(() => {
    controller.abort();
    return Response.json({ requestToken: "token" });
  });

  await expect(
    createAssetAdministrationService(actor, http.fetch).changeAvailability(
      candidate.id,
      "remove",
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(localStorage.getItem(recoveryKey)).toBeNull();
  expect(http.requests).toHaveLength(1);
});

it("leaves another actor's keyed recovery untouched", async () => {
  localStorage.setItem(recoveryKey, removalMarker);
  const otherActor = "33333333-3333-4333-8333-333333333333";
  const http = await serveHttp((incoming) => {
    expect(incoming.headers.get("X-Spatia-Account")).toBe(otherActor);
    return Response.json(catalogue);
  });

  expect(
    (
      await createAssetAdministrationService(otherActor, http.fetch).load(
        new AbortController().signal,
      )
    ).ok,
  ).toBe(true);
  expect(http.requests).toHaveLength(1);
  expect(localStorage.getItem(recoveryKey)).toBe(removalMarker);
});

it.each(["{", "{}", JSON.stringify({ assetId: candidate.id, operationId: "" })])(
  "keeps malformed recovery data fenced: %s",
  async (marker) => {
    localStorage.setItem(recoveryKey, marker);
    const http = await serveHttp(() => Response.json(catalogue));

    const service = createAssetAdministrationService(actor, http.fetch);
    expect((await service.load(new AbortController().signal)).ok).toBe(false);
    expect(
      await service.changeAvailability(candidate.id, "hide", new AbortController().signal),
    ).toMatchObject({ ok: false, kind: "unknown" });
    expect(localStorage.getItem(recoveryKey)).toBe(marker);
    expect(http.requests).toHaveLength(0);
  },
);

it("removes a tag by naming only that tag, so newer details are not resent", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "token" }),
    Response.json({ ...candidate, name: "Renamed elsewhere", tags: ["Modern Singapore"] }),
  );
  const result = await createAssetAdministrationService(actor, http.fetch).removeTag(
    candidate.id,
    "Post-war",
    new AbortController().signal,
  );
  expect(result.ok && result.value.name).toBe("Renamed elsewhere");
  const sent = http.requests[1]!;
  expect(new URL(sent.url).pathname).toBe(`/api/v1/admin/assets/${candidate.id}/tags/remove`);
  expect(sent.method).toBe("POST");
  expect(await sent.json()).toEqual({ tag: "Post-war" });
});
