import { expect, it, vi } from "vitest";
import { createModelLoadQueue } from "./model-load-queue";

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
