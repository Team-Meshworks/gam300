import { expect, it } from "vitest";
import { deferred } from "../../tests/deferred";
import { serveHttp } from "../../tests/http-fixture";
import { createModelLoadQueue } from "./model-load-queue";

it("loads only requested models, deduplicates, and continues after an independent failure", async () => {
  const downloads = new Map(
    ["room", "broken", "crate"].map(
      (id) => [id, { started: deferred<void>(), response: deferred<Response>() }] as const,
    ),
  );
  const server = await serveHttp((request) => {
    const id = new URL(request.url).pathname.slice(1);
    const download = downloads.get(id);
    if (!download) throw new Error("Unexpected model " + id);
    download.started.resolve();
    return download.response.promise;
  });
  const queue = createModelLoadQueue(
    async (id) => {
      const response = await server.fetch("/" + id);
      if (!response.ok) throw new Error(String(response.status));
    },
    () => {},
  );
  expect(server.requests).toHaveLength(0);
  const room = queue.request("room");
  expect(queue.request("room")).toBe(room);
  const broken = queue.request("broken");
  const crate = queue.request("crate");
  await Promise.all([
    downloads.get("room")!.started.promise,
    downloads.get("broken")!.started.promise,
  ]);
  expect(server.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/room",
    "/broken",
  ]);
  downloads.get("broken")!.response.resolve(new Response(null, { status: 401 }));
  expect(await broken).toBe(false);
  await downloads.get("crate")!.started.promise;
  downloads.get("room")!.response.resolve(new Response());
  downloads.get("crate")!.response.resolve(new Response());
  expect(await room).toBe(true);
  expect(await crate).toBe(true);
  expect(queue.pending).toBe(0);
  expect([...queue.errors.keys()]).toEqual(["broken"]);
});
