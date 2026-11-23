import { expect, it } from "vitest";
import { serveHttp } from "../../tests/http-fixture";
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
async function fixture() {
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
  const { fetch: request, requests } = await serveHttp((input) => {
    const url = new URL(input.url);
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
  return { api: createExistingProjectClient(request), state, requests };
}
it("lists both pages and archived equal-name projects by their exact UUID, scoped to the actor", async () => {
  const { api, requests } = await fixture();
  expect((await api.list(actor)).map((row) => [row.projectId, row.title, row.archived])).toEqual([
    [one, "Equal title", false],
    [two, "Equal title", false],
    [archived, "Equal title", true],
  ]);
  for (const sent of requests.filter(({ url }) => new URL(url).pathname.includes("/projects"))) {
    expect(sent.cache).toBe("no-store");
    expect(sent.headers.get("X-Spatia-Account")).toBe(actor);
    expect(sent.url).not.toContain(hidden);
  }
});
it("reads the exact UUID and current revision without assuming archived metadata in the resource response", async () => {
  const { api, requests } = await fixture();
  expect(await api.read(actor, one, true)).toEqual({
    projectId: one,
    title: "Equal title",
    revision: 7,
    archived: false,
  });
  expect(requests.some(({ url }) => new URL(url).pathname === "/api/v1/projects/" + one)).toBe(
    true,
  );
  await expect(api.read(actor, archived, true)).rejects.toThrow("active and manageable");
  await expect(api.read(actor, hidden, false)).rejects.toThrow();
});
it("requires re-review when revision changes and rejects lost management, mismatched IDs and changed actors", async () => {
  const { api, state } = await fixture();
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
  const { api, state } = await fixture();
  const store = sessionStorage;
  store.setItem(historicalCreationKey(actor), "1");
  store.setItem(historicalCreationKey(two), "1");
  const verify = () => api.check(actor);
  store.setItem(historicalCreationKey(actor), "changed");
  expect(await clearHistoricalCreation(store, actor, "1", verify)).toBe(false);
  expect(store.getItem(historicalCreationKey(actor))).toBe("changed");
  await expect(clearHistoricalCreation(store, actor, "changed", verify)).rejects.toThrow(
    "could not be verified",
  );
  store.setItem(historicalCreationKey(actor), "1");
  state.actor = two;
  await expect(clearHistoricalCreation(store, actor, "1", verify)).rejects.toThrow(
    "account changed",
  );
  state.actor = actor;
  expect(store.getItem(historicalCreationKey(actor))).toBe("1");
  expect(await clearHistoricalCreation(store, actor, "1", verify)).toBe(true);
  expect(store.getItem(historicalCreationKey(two))).toBe("1");
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
