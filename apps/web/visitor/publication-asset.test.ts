import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicationAsset } from "./publication-asset";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers transient saturation while preserving authenticated delivery", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "1" } }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response("retained bytes"));
  vi.stubGlobal("fetch", request);
  const pending = fetchPublicationAsset(
    "/api/publications/test/assets/test/bytes",
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(501);
  expect(await (await pending).text()).toBe("retained bytes");
  expect(request).toHaveBeenCalledTimes(3);
  expect(
    request.mock.calls.every(
      ([, options]) => options?.credentials === "same-origin" && options.cache === "no-store",
    ),
  ).toBe(true);
});

it("bounds retries and never retries permanent access denials", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", request);
  const pending = fetchPublicationAsset("/bytes", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  expect((await pending).status).toBe(429);
  expect(request).toHaveBeenCalledTimes(5);
  request.mockClear().mockResolvedValue(new Response(null, { status: 403 }));
  expect((await fetchPublicationAsset("/bytes", new AbortController().signal)).status).toBe(403);
  expect(request).toHaveBeenCalledTimes(1);
});

it("cancels a pending retry when the scene is disposed", async () => {
  vi.useFakeTimers();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", request);
  const controller = new AbortController();
  const pending = fetchPublicationAsset("/bytes", controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(1);
});
