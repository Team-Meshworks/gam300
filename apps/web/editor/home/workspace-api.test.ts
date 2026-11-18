import { expect, it } from "vitest";
import { serveResponses } from "../../tests/http-fixture";
import { createWorkspaceClient, projectReceipt, type ProjectSummary } from "./workspace-api";

const actor = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const id = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const session = {
  userId: actor,
  displayName: "Teacher",
  role: "Educator",
  orgId: id,
  mustChangePassword: false,
};
const row: ProjectSummary = {
  projectId: id,
  title: "Class project",
  revision: 3,
  updatedAt: "2026-10-30T01:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: false, canPublish: false },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

it("reads all authorised pages without caching and rejects a cyclic cursor", async () => {
  const { fetch: request, requests } = await serveResponses(
    json({ items: [row], nextCursor: id }),
    json({ items: [], nextCursor: null }),
  );
  expect(await createWorkspaceClient(request).projects(false)).toEqual([row]);
  expect(requests[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  expect(new URL(requests[1]!.url).search).toBe(`?archived=false&limit=20&cursor=${id}`);
  const cyclic = await serveResponses(
    json({ items: [row], nextCursor: id }),
    json({ items: [row], nextCursor: id }),
  );
  await expect(createWorkspaceClient(cyclic.fetch).projects(false)).rejects.toThrow("completed");
  expect(cyclic.requests).toHaveLength(2);
});
it("rejects partial or malformed project permissions and inconsistent pages", async () => {
  for (const items of [
    [{ ...row, permissions: { canEdit: true } }],
    [row, row],
    [{ ...row, archived: true }],
    [{ ...row, revision: 0.5 }],
  ]) {
    const { fetch: request } = await serveResponses(json({ items, nextCursor: null }));
    await expect(createWorkspaceClient(request).projects(false)).rejects.toThrow("verified");
  }
});
it("rechecks identity after obtaining CSRF, without submitting another account's change", async () => {
  const { fetch: request, requests } = await serveResponses(
    json(session),
    json({ requestToken: "token" }),
    json({ ...session, userId: id }),
  );
  expect(
    (
      await createWorkspaceClient(request).write(actor, `/api/v1/projects/${id}/archive`, "PATCH", {
        expectedRevision: 3,
        archived: true,
      })
    ).kind,
  ).toBe("rejected");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});
it("sends the exact revision with CSRF and verifies the resulting account", async () => {
  const receipt = { projectId: id, revision: 4, archived: true, updatedAt: row.updatedAt };
  const { fetch: request, requests } = await serveResponses(
    json(session),
    json({ requestToken: "token" }),
    json(session),
    json(receipt),
    json(session),
  );
  expect(
    await createWorkspaceClient(request).write(actor, `/api/v1/projects/${id}/archive`, "PATCH", {
      expectedRevision: 3,
      archived: true,
    }),
  ).toEqual({ kind: "confirmed", value: receipt });
  expect(requests[3]).toMatchObject({
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
  });
  expect(requests[3]!.headers.get("X-CSRF-TOKEN")).toBe("token");
  expect(requests[3]!.headers.get("X-Spatia-Account")).toBe(actor);
  expect(await requests[3]!.text()).toBe(JSON.stringify({ expectedRevision: 3, archived: true }));
});
it("does not turn post-send failures or expired sessions into a safe retry", async () => {
  for (const status of [401, 403, 404, 503]) {
    const { fetch: request, requests } = await serveResponses(
      json(session),
      json({ requestToken: "token" }),
      json(session),
      new Response(null, { status }),
    );
    expect(
      await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {}),
    ).toEqual({
      kind: "unknown",
    });
    expect(requests).toHaveLength(4);
  }
  const { fetch: request } = await serveResponses(
    json(session),
    json({ requestToken: "token" }),
    json(session),
    Response.error(),
  );
  expect(await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {})).toEqual(
    {
      kind: "unknown",
    },
  );
});
it("keeps a committed write pending until its protected receipt can be recovered", async () => {
  const { fetch: request, requests } = await serveResponses(
    json(session),
    json({ requestToken: "token" }),
    json(session),
    new Response(null, {
      status: 204,
      headers: { "X-Spatia-Write-Outcome": "committed" },
    }),
  );
  expect(await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {})).toEqual(
    { kind: "unknown" },
  );
  expect(requests).toHaveLength(4);
});
it("preserves a creation identity conflict for callers with no custom error message", async () => {
  const { fetch: request } = await serveResponses(
    json(session),
    json({ requestToken: "token" }),
    json(session),
    new Response(JSON.stringify({ code: "operation_conflict" }), { status: 409 }),
  );
  expect(
    await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {}),
  ).toMatchObject({ kind: "rejected", code: "operation_conflict" });
});
it("checks receipts against the requested project, revision and archive state", () => {
  const receipt = { projectId: id, revision: 4, archived: true, updatedAt: row.updatedAt };
  expect(projectReceipt(receipt, row, true)).toBe(true);
  expect(projectReceipt({ ...receipt, revision: 5 }, row, true)).toBe(false);
  expect(projectReceipt({ ...receipt, projectId: actor }, row, true)).toBe(false);
  expect(projectReceipt({ ...receipt, archived: false }, row, true)).toBe(false);
  expect(projectReceipt({ ...receipt, projectId: actor, revision: 0, archived: false }, row)).toBe(
    true,
  );
  expect(projectReceipt({ ...receipt, revision: 0, archived: false }, row)).toBe(false);
});
