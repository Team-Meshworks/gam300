import { expect, it, vi } from "vitest";
import {
  createExistingProjectClient,
  clearHistoricalCreation,
  historicalCreationKey,
} from "./existing-project";
import { classLabels } from "../projects/class-labels";
const actor = "11111111-1111-4111-8111-111111111111";
const one = "22222222-2222-4222-8222-222222222222";
const two = "33333333-3333-4333-8333-333333333333";
const archived = "44444444-4444-4444-8444-444444444444";
const hidden = "55555555-5555-4555-8555-555555555555";
function fixture() {
  const state = { actor, revision: 7, manageable: true, switchAfterRead: false, returnedId: one };
  const rows = () =>
    [one, two, archived].map((projectId) => ({
      projectId,
      title: "Equal title",
      revision: projectId === one ? state.revision : 0,
      archived: projectId === archived,
      updatedAt: "2026-11-14T00:00:00Z",
      permissions: { canManage: state.manageable, canEdit: true, canPublish: false },
    }));
  const request = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname.endsWith("/auth/session"))
      return Response.json({
        userId: state.actor,
        role: "Educator",
        orgId: hidden,
        displayName: "Teacher",
        mustChangePassword: false,
      });
    if (url.pathname === "/api/v1/projects") {
      const all = rows().filter(
        (row) => row.archived === (url.searchParams.get("archived") === "true"),
      );
      if (url.searchParams.get("archived") === "true")
        return Response.json({ items: all, nextCursor: null });
      return Response.json(
        url.searchParams.has("cursor")
          ? { items: all.slice(1), nextCursor: null }
          : { items: all.slice(0, 1), nextCursor: two },
      );
    }
    const id = url.pathname.split("/").at(-1);
    const found = rows().find((row) => row.projectId === id);
    if (!found) return Response.json({}, { status: 404 });
    if (state.switchAfterRead) state.actor = two;
    return Response.json({
      projectId: id === one ? state.returnedId : id,
      revision: found.revision,
      document: { title: found.title },
      permissions: { canEdit: true },
    });
  });
  return { api: createExistingProjectClient(request), state, request };
}
it("lists both pages and archived equal-name projects by their exact UUID, scoped to the actor", async () => {
  const { api, request } = fixture();
  expect((await api.list(actor)).map((row) => [row.projectId, row.title, row.archived])).toEqual([
    [one, "Equal title", false],
    [two, "Equal title", false],
    [archived, "Equal title", true],
  ]);
  for (const [path, options] of request.mock.calls.filter(([path]) =>
    String(path).includes("/projects"),
  )) {
    expect(options).toMatchObject({ cache: "no-store", headers: { "X-Spatia-Account": actor } });
    expect(String(path)).not.toContain(hidden);
  }
});
it("reads the exact UUID and current revision without assuming archived metadata in the resource response", async () => {
  const { api, request } = fixture();
  expect(await api.read(actor, one, true)).toEqual({
    projectId: one,
    title: "Equal title",
    revision: 7,
    archived: false,
  });
  expect(request.mock.calls.some(([path]) => path === "/api/v1/projects/" + one)).toBe(true);
  await expect(api.read(actor, archived, true)).rejects.toThrow("active and manageable");
  await expect(api.read(actor, hidden, false)).rejects.toThrow();
});
it("requires re-review when revision changes and rejects lost management, mismatched IDs and changed actors", async () => {
  const { api, state } = fixture();
  const reviewed = await api.read(actor, one, true);
  state.revision = 8;
  await expect(api.confirm(actor, reviewed, true)).rejects.toThrow("changed since review");
  state.manageable = false;
  await expect(api.read(actor, one, true)).rejects.toThrow("active and manageable");
  state.manageable = true;
  state.returnedId = two;
  await expect(api.read(actor, one, true)).rejects.toThrow("could not be verified");
  state.returnedId = one;
  state.switchAfterRead = true;
  await expect(api.read(actor, one, true)).rejects.toThrow("account changed");
});
it("clears only the observed actor's exact historical sentinel after rechecking that actor", async () => {
  const records = new Map([
    [historicalCreationKey(actor), "1"],
    [historicalCreationKey(two), "1"],
  ]);
  const store = {
    getItem: (key: string) => records.get(key) ?? null,
    removeItem: (key: string) => {
      records.delete(key);
    },
  };
  const verify = vi.fn(async () => {});
  records.set(historicalCreationKey(actor), "changed");
  expect(await clearHistoricalCreation(store, actor, "1", verify)).toBe(false);
  expect(records.get(historicalCreationKey(actor))).toBe("changed");
  await expect(clearHistoricalCreation(store, actor, "changed", verify)).rejects.toThrow(
    "could not be verified",
  );
  records.set(historicalCreationKey(actor), "1");
  await expect(
    clearHistoricalCreation(store, actor, "1", async () => {
      throw new Error("Account changed");
    }),
  ).rejects.toThrow("Account changed");
  expect(records.get(historicalCreationKey(actor))).toBe("1");
  expect(await clearHistoricalCreation(store, actor, "1", verify)).toBe(true);
  expect(records.get(historicalCreationKey(two))).toBe("1");
});
it("disambiguates equal class names in one shared mapping while preserving unique labels", () => {
  const labels = classLabels([
    { id: one, label: "History" },
    { id: two, label: "History" },
    { id: archived, label: "Geography" },
  ]);
  expect([...labels.values()]).toEqual([
    "History (" + one + ")",
    "History (" + two + ")",
    "Geography",
  ]);
});
