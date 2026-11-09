import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicationAsset } from "./publication-asset";

afterEach(() => {
  vi.restoreAllMocks();
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
    "/api/v1/publications/test/assets/test/bytes",
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

it("waits through six seconds of saturated permits instead of failing on the fifth response", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Date.now() - started < 6000
        ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        : new Response("retained bytes"),
    );
  vi.stubGlobal("fetch", request);
  const pending = fetchPublicationAsset("/bytes", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await (await pending).text()).toBe("retained bytes");
  expect(request.mock.calls.length).toBeGreaterThan(5);
});

it("allows a slow permitted transfer to release a slot after thirty seconds", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Date.now() - started < 65000
        ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
        : new Response("retained bytes"),
    );
  vi.stubGlobal("fetch", request);
  const pending = fetchPublicationAsset("/bytes", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(70000);
  expect(await (await pending).text()).toBe("retained bytes");
});

it("bounds retries by elapsed time and never retries permanent access denials", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", request);
  const pending = fetchPublicationAsset("/bytes", new AbortController().signal);
  const outcome = pending.then(
    () => ({ name: "UnexpectedSuccess" }),
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(300000);
  expect(await outcome).toMatchObject({ name: "TimeoutError" });
  const attempts = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(attempts);
  expect(attempts).toBeLessThan(70);
  request.mockClear().mockResolvedValue(new Response(null, { status: 403 }));
  expect((await fetchPublicationAsset("/bytes", new AbortController().signal)).status).toBe(403);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["12", "Thu, 01 Jan 2026 00:00:12 GMT"])(
  "honours Retry-After %s beyond the backoff cap",
  async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cancelled = vi.fn();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      )
      .mockResolvedValueOnce(new Response("retained bytes"));
    vi.stubGlobal("fetch", request);
    const pending = fetchPublicationAsset("/bytes", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(11999);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).text()).toBe("retained bytes");
  },
);

it("expires instead of retrying early when Retry-After exceeds the remaining budget", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "600" } }));
  vi.stubGlobal("fetch", request);
  const outcome = fetchPublicationAsset("/bytes", new AbortController().signal).catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(300000);
  expect(await outcome).toMatchObject({ name: "TimeoutError" });
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
