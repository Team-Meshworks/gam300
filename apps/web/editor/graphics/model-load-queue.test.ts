import { expect, it, vi } from "vitest";
import { createModelLoadQueue } from "./model-load-queue";

it("warms one selected model without blocking the scene and promotes the same load on placement", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const load = vi.fn(async (id: string) => {
    if (id === "bench") await gate;
    else throw new Error("unavailable");
  });
  const queue = createModelLoadQueue(load, vi.fn());
  const warm = queue.preload("bench");
  expect(queue.pending).toBe(0);
  const place = queue.request("bench");
  expect(queue.pending).toBe(1);
  finish();
  expect(await place).toBe(true);
  expect(await warm).toBe(true);
  expect(load.mock.calls).toEqual([["bench"]]);
  expect(await queue.preload("broken")).toBe(false);
  expect(queue.errors.size).toBe(0);
  expect(await queue.request("broken")).toBe(false);
  expect(queue.errors.has("broken")).toBe(true);
});

it("drops unstarted selections on closing the picker and prioritises authored loads", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const load = vi.fn(async (id: string) => {
    if (id.startsWith("active")) await gate;
  });
  const queue = createModelLoadQueue(load, vi.fn());
  void queue.request("active1");
  void queue.request("active2");
  const first = queue.preload("first");
  const last = queue.preload("last");
  void queue.preload(null);
  const required = queue.request("required");
  finish();
  expect(await first).toBe(false);
  expect(await last).toBe(false);
  expect(await required).toBe(true);
  expect(load.mock.calls.flat()).toEqual(["active1", "active2", "required"]);
});

it("loads only requested models, deduplicates, and continues after an independent failure", async () => {
  const releases = new Map<string, () => void>();
  const load = vi.fn(
    (id: string) =>
      new Promise<void>((resolve, reject) => {
        releases.set(id, () => (id === "broken" ? reject(new Error("401")) : resolve()));
      }),
  );
  const queue = createModelLoadQueue(load, vi.fn());
  expect(load).not.toHaveBeenCalled();
  const room = queue.request("room");
  expect(queue.request("room")).toBe(room);
  const broken = queue.request("broken");
  const crate = queue.request("crate");
  await Promise.resolve();
  expect(load.mock.calls.map(([id]) => id)).toEqual(["room", "broken"]);
  releases.get("broken")!();
  expect(await broken).toBe(false);
  await Promise.resolve();
  expect(load).toHaveBeenCalledWith("crate");
  releases.get("room")!();
  releases.get("crate")!();
  expect(await room).toBe(true);
  expect(await crate).toBe(true);
  expect(queue.pending).toBe(0);
  expect([...queue.errors.keys()]).toEqual(["broken"]);
});
