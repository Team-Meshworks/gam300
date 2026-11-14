import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAssetAdministrationService } from "./asset-administration-service";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
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
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return Response.json(url === "/api/v1/auth/csrf" ? { requestToken: "token" } : candidate);
    }),
  );
  const review = { source: "Museum archive", license: "CC BY 4.0", reviewNotes: "Rights checked" };
  const file = new File(["model"], "crate.glb", { type: "model/gltf-binary" });
  await createAssetAdministrationService(actor).submit(
    { file, kind: "model", category: "Objects", review },
    new AbortController().signal,
  );
  const encoded = new Headers(calls[1]?.init?.headers).get("X-Spatia-Asset-Metadata");
  expect(encoded).not.toBeNull();
  expect(
    JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded!), (c) => c.charCodeAt(0)))),
  ).toEqual(review);
  expect(calls[1]?.init?.body).toBe(file);
});

it.each([
  [`/api/v1/admin/assets/${actor}/bytes`, true],
  [`/api/admin/assets/${actor}/bytes`, false],
  [`/api/v2/admin/assets/${actor}/bytes`, false],
  [`https://elsewhere.test/api/v1/admin/assets/${actor}/bytes`, false],
])("validates the version and origin of inspection URL %s", async (inspectionUrl, accepted) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url === "/api/v1/auth/csrf"
          ? { requestToken: "current-token" }
          : { ...candidate, id: actor, inspectionUrl },
      ),
    ),
  );
  const result = await createAssetAdministrationService(actor).changeAvailability(
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url === "/api/v1/auth/csrf"
            ? { requestToken: "current-token" }
            : {
                ...candidate,
                id: actor,
                sha256,
                inspectionUrl: `/api/v1/admin/assets/${actor}/bytes`,
              },
        ),
      ),
    );
    const result = await createAssetAdministrationService(actor).changeAvailability(
      actor,
      "hide",
      new AbortController().signal,
    );
    expect(result.ok).toBe(accepted);
    if (result.ok) expect(result.value.sha256).toBe(sha256);
  },
);

it("sends an explicit destructive opt-in with the current CSRF token on the same origin", async () => {
  // Capture the token request before the mutation to prove writes use the current account session
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(
        url === "/api/v1/auth/csrf"
          ? { requestToken: "current-token" }
          : { ...candidate, hidden: true, deleted: true, removedFromProjects: true, actions: [] },
      );
    }),
  );
  const result = await createAssetAdministrationService(actor).changeAvailability(
    "asset-1",
    "delete",
    new AbortController().signal,
    true,
  );
  expect(result.ok).toBe(true);
  expect(calls.map((call) => call.url)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/admin/assets/asset-1/availability",
  ]);
  expect(calls[1]?.init?.credentials).toBe("same-origin");
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get("X-Spatia-Account")).toBe(actor);
  }
  expect(new Headers(calls[1]?.init?.headers).get("X-CSRF-TOKEN")).toBe("current-token");
  expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({
    action: "delete",
    removeFromProjects: true,
  });
});

it("keeps denial, unavailable removal and malformed server responses distinct from success", async () => {
  // Permission loss and unavailable removal must leave the caller outside the success branch
  for (const status of [403, 503]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    const result = await createAssetAdministrationService(actor).load(new AbortController().signal);
    expect(result).toMatchObject({ ok: false, kind: status === 403 ? "denied" : "unavailable" });
  }
  // A partial policy must not enable a screen even when the candidate itself is well formed
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ assets: [candidate], policy: { canForceRemove: true } })),
  );
  expect(
    await createAssetAdministrationService(actor).load(new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "unavailable" });
});

it("binds catalogue reads, downloads and writes to the original account", async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const service = createAssetAdministrationService(actor);
  expect(await service.load(new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "denied",
  });
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Spatia-Account")).toBe(actor);
  fetcher.mockClear();
  expect(
    await service.changeAvailability(candidate.id, "hide", new AbortController().signal),
  ).toMatchObject({ ok: false, kind: "denied" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/auth/csrf");

  // A denied download leaves the dialog open instead of navigating to a problem response
  fetcher.mockClear();
  expect(await service.download(actor, new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "denied",
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/v1/admin/assets/${actor}/bytes`);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Spatia-Account")).toBe(actor);
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  expect(fetcher.mock.calls[0]?.[1]?.cache).toBe("no-store");
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

  // Download the exact returned bytes while an empty response remains a visible failure
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
  const downloaded = await service.download(actor, new AbortController().signal);
  expect(downloaded.ok).toBe(true);
  if (downloaded.ok) {
    expect(new Uint8Array(await downloaded.value.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  }
  fetcher.mockResolvedValueOnce(new Response(null));
  expect(await service.download(actor, new AbortController().signal)).toMatchObject({
    ok: false,
    kind: "unavailable",
  });
});

it("submits M4A audio with its MIME, category and captured account", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return Response.json(
        url === "/api/v1/auth/csrf"
          ? { requestToken: "token" }
          : { ...candidate, kind: "audio", category: "BGM" },
      );
    }),
  );
  const file = new File(["audio"], "music.m4a", { type: "audio/mp4" });
  const result = await createAssetAdministrationService(actor).submit(
    {
      file,
      kind: "audio",
      category: "BGM",
      review: { source: "", license: "", reviewNotes: "" },
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  expect(calls[1]?.url).toBe("/api/v1/admin/assets?name=music.m4a&kind=audio&category=BGM");
  expect(calls[1]?.init?.body).toBe(file);
  expect(new Headers(calls[1]?.init?.headers).get("Content-Type")).toBe("audio/mp4");
  expect(new Headers(calls[1]?.init?.headers).get("X-Spatia-Account")).toBe(actor);
});

it.each([
  [[".glb"], undefined, true],
  [[".glb", ".m4a"], ["BGM"], true],
  [[".glb", ".m4a"], undefined, false],
  [[".glb", ".mp3"], ["BGM"], false],
])("validates the deployed audio policy %j", async (extensions, audio, accepted) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
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
    ),
  );
  expect(
    (await createAssetAdministrationService(actor).load(new AbortController().signal)).ok,
  ).toBe(accepted);
});

it.each([true, "yes"])("validates per-kind upload availability %j", async (audio) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
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
    ),
  );
  const result = await createAssetAdministrationService(actor).load(new AbortController().signal);
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/auth/csrf") {
        if (failure === "csrf") throw new TypeError("Not sent");
        return Response.json({ requestToken: "token" });
      }
      if (failure === "lost") throw new TypeError("Lost response");
      if (failure === "gateway") return new Response(null, { status: 502 });
      if (failure === "rejected")
        return Response.json({ code: "asset_intake_unavailable" }, { status: 503 });
      return Response.json({});
    }),
  );
  const result = await createAssetAdministrationService(actor).submit(
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

it("treats a dispatched asset removal returning 401 as unknown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/v1/auth/csrf"
        ? Response.json({ requestToken: "token" })
        : new Response(null, { status: 401 }),
    ),
  );
  const result = await createAssetAdministrationService(actor).changeAvailability(
    "asset",
    "remove",
    new AbortController().signal,
    true,
  );
  expect(result).toMatchObject({ ok: false, kind: "unknown" });
});

it.each([401, 403])("distinguishes asset %s preflight and dispatched responses", async (status) => {
  let preflight = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/auth/csrf")
        return preflight
          ? new Response(null, { status })
          : Response.json({ requestToken: "token" });
      return new Response(null, { status });
    }),
  );
  const service = createAssetAdministrationService(actor);
  const run = () =>
    service.changeAvailability("asset", "remove", new AbortController().signal, true);
  expect(await run()).toMatchObject({ ok: false, kind: "denied" });
  preflight = false;
  expect(await run()).toMatchObject({ ok: false, kind: status === 401 ? "unknown" : "denied" });
});

it("retains an uncertain removal across service reentry until an authorized catalogue load", async () => {
  let writes = 0;
  let catalogAllowed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      if (init?.method) {
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
    }),
  );
  const signal = new AbortController().signal;
  const first = createAssetAdministrationService(actor);
  expect(await first.changeAvailability("asset", "remove", signal, true)).toMatchObject({
    kind: "unknown",
  });
  const reopened = createAssetAdministrationService(actor);
  expect(await reopened.changeAvailability("asset", "remove", signal, true)).toMatchObject({
    kind: "unknown",
  });
  expect(writes).toBe(1);
  expect((await reopened.load(signal)).ok).toBe(false);
  expect(await reopened.changeAvailability("asset", "remove", signal, true)).toMatchObject({
    kind: "unknown",
  });
  expect(writes).toBe(1);
  catalogAllowed = true;
  expect((await reopened.load(signal)).ok).toBe(true);
  await reopened.changeAvailability("asset", "remove", signal, true);
  expect(writes).toBe(2);
});

it("serializes concurrent asset writes before either can bypass the recovery fence", async () => {
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      if (init?.method) {
        writes++;
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 401 });
    }),
  );
  const signal = new AbortController().signal;
  const first = createAssetAdministrationService(actor);
  const second = createAssetAdministrationService(actor);
  await Promise.all([
    first.changeAvailability("asset", "remove", signal, true),
    second.changeAvailability("asset", "remove", signal, true),
  ]);
  expect(writes).toBe(1);
});

it("does not dispatch an asset removal when the recovery marker cannot be stored", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  });
  const request = vi.fn(async () => Response.json({ requestToken: "token" }));
  vi.stubGlobal("fetch", request);
  const result = await createAssetAdministrationService(actor).changeAvailability(
    "asset",
    "remove",
    new AbortController().signal,
    true,
  );
  expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("allows read-only catalogue access without browser coordination or storage", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("unavailable");
    },
  });
  const request = vi.fn(async () =>
    Response.json({
      assets: [candidate],
      policy: {
        extensions: [".glb"],
        maxBytes: 1000,
        canSubmit: true,
        canForceRemove: true,
        categories: { environment: null, model: ["Objects"] },
      },
    }),
  );
  vi.stubGlobal("fetch", request);
  const service = createAssetAdministrationService(actor);
  expect((await service.load(new AbortController().signal)).ok).toBe(true);
  expect(
    (await service.changeAvailability("asset", "remove", new AbortController().signal, true)).ok,
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it("rejects an empty CSRF token before dispatching an asset write", async () => {
  const request = vi.fn(async () => Response.json({ requestToken: "" }));
  vi.stubGlobal("fetch", request);
  const result = await createAssetAdministrationService(actor).changeAvailability(
    "asset",
    "remove",
    new AbortController().signal,
    true,
  );
  expect(result).toMatchObject({ ok: false, kind: "unavailable" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not clear a pending asset marker when displaying a catalogue without locks", async () => {
  const key = `spatia.asset-write:${actor}`;
  localStorage.setItem(key, "pending");
  vi.stubGlobal("navigator", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        assets: [candidate],
        policy: {
          extensions: [".glb"],
          maxBytes: 1000,
          canSubmit: true,
          canForceRemove: true,
          categories: { environment: null, model: ["Objects"] },
        },
      }),
    ),
  );
  expect(
    (await createAssetAdministrationService(actor).load(new AbortController().signal)).ok,
  ).toBe(true);
  expect(localStorage.getItem(key)).toBe("pending");
});

it("allows catalogue reads when storage fails even if browser locks exist", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("unavailable");
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        assets: [candidate],
        policy: {
          extensions: [".glb"],
          maxBytes: 1000,
          canSubmit: true,
          canForceRemove: true,
          categories: { environment: null, model: ["Objects"] },
        },
      }),
    ),
  );
  const service = createAssetAdministrationService(actor);
  expect((await service.load(new AbortController().signal)).ok).toBe(true);
  expect(
    (await service.changeAvailability("asset", "remove", new AbortController().signal, true)).ok,
  ).toBe(false);
});
