import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPlayerAsset } from "../shared/player/player-asset";
import { deferred } from "../tests/deferred";
import { serveHttp, serveResponses } from "../tests/http-fixture";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function saturated(status: 429 | 503, retryAfter?: string) {
  const cancelled = deferred<void>();
  const body = new ReadableStream({ cancel: () => cancelled.resolve() });
  const headers = retryAfter === undefined ? {} : { "Retry-After": retryAfter };
  return {
    response: new Response(body, { status, headers }),
    cancelled: cancelled.promise,
  };
}

async function serveSaturation(permitAfterMs: number, retryAfter?: string) {
  const started = Date.now();
  let attempts = 0;
  let nextCancellation = deferred<void>();
  const server = await serveHttp(() => {
    attempts++;
    if (Date.now() - started >= permitAfterMs) return new Response("retained bytes");
    const { response, cancelled } = saturated(429, retryAfter);
    const { resolve } = nextCancellation;
    void cancelled.then(resolve);
    return response;
  });
  return {
    url: `${server.origin}/bytes`,
    attempts: () => attempts,
    async advanceUntil(elapsedMs: number) {
      while (Date.now() - started < elapsedMs) {
        await nextCancellation.promise;
        nextCancellation = deferred<void>();
        await vi.advanceTimersToNextTimerAsync();
      }
    },
  };
}

it("recovers transient saturation while preserving authenticated delivery", async () => {
  const first = saturated(429, "1");
  const second = saturated(503);
  const server = await serveResponses(
    first.response,
    second.response,
    new Response("retained bytes"),
  );
  const fetchCalls = vi.spyOn(globalThis, "fetch");
  const pending = fetchPlayerAsset(
    `${server.origin}/api/v1/publications/test/assets/test/bytes`,
    new AbortController().signal,
  );
  await first.cancelled;
  await vi.advanceTimersByTimeAsync(999);
  expect(fetchCalls).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await second.cancelled;
  await vi.advanceTimersByTimeAsync(500);
  expect(await (await pending).text()).toBe("retained bytes");
  expect(fetchCalls).toHaveBeenCalledTimes(3);
  expect(
    fetchCalls.mock.calls.every(
      ([, options]) => options?.credentials === "same-origin" && options.cache === "no-store",
    ),
  ).toBe(true);
});

it("waits through six seconds of saturated permits instead of failing on the fifth response", async () => {
  const server = await serveSaturation(6000, "1");
  const pending = fetchPlayerAsset(server.url, new AbortController().signal);
  await server.advanceUntil(6000);
  expect(await (await pending).text()).toBe("retained bytes");
  expect(server.attempts()).toBeGreaterThan(5);
});

it("allows a slow permitted transfer to release a slot after thirty seconds", async () => {
  const server = await serveSaturation(65000, "1");
  const pending = fetchPlayerAsset(server.url, new AbortController().signal);
  await server.advanceUntil(65000);
  expect(await (await pending).text()).toBe("retained bytes");
});

it("bounds retries by elapsed time and never retries permanent access denials", async () => {
  const server = await serveSaturation(Infinity);
  const pending = fetchPlayerAsset(server.url, new AbortController().signal);
  const outcome = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  await server.advanceUntil(300000);
  await outcome;
  const attempts = server.attempts();
  await vi.advanceTimersByTimeAsync(10000);
  expect(server.attempts()).toBe(attempts);
  expect(attempts).toBeLessThan(70);
  const denied = await serveResponses(new Response(null, { status: 403 }));
  expect(
    (await fetchPlayerAsset(`${denied.origin}/bytes`, new AbortController().signal)).status,
  ).toBe(403);
});

it.each(["12", "Thu, 01 Jan 2026 00:00:12 GMT"])(
  "honours Retry-After %s beyond the backoff cap",
  async (retryAfter) => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = saturated(429, retryAfter);
    const server = await serveResponses(first.response, new Response("retained bytes"));
    const fetchCalls = vi.spyOn(globalThis, "fetch");
    const pending = fetchPlayerAsset(`${server.origin}/bytes`, new AbortController().signal);
    await first.cancelled;
    await vi.advanceTimersByTimeAsync(11999);
    expect(fetchCalls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).text()).toBe("retained bytes");
  },
);

it("expires instead of retrying early when Retry-After exceeds the remaining budget", async () => {
  const first = saturated(429, "600");
  const server = await serveResponses(first.response);
  const pending = fetchPlayerAsset(`${server.origin}/bytes`, new AbortController().signal);
  const outcome = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  await first.cancelled;
  await vi.advanceTimersByTimeAsync(300000);
  await outcome;
});

it("cancels a pending retry when the scene is disposed", async () => {
  const first = saturated(429);
  const server = await serveResponses(first.response);
  const controller = new AbortController();
  const pending = fetchPlayerAsset(`${server.origin}/bytes`, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await first.cancelled;
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
});
