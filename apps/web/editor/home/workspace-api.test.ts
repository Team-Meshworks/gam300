import { expect, it, vi } from "vitest";
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
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ items: [row], nextCursor: id }))
    .mockResolvedValueOnce(json({ items: [], nextCursor: null }));
  expect(await createWorkspaceClient(request).projects(false)).toEqual([row]);
  expect(request.mock.calls[1]).toMatchObject([
    `/api/v1/projects?archived=false&limit=20&cursor=${id}`,
    { credentials: "same-origin", cache: "no-store" },
  ]);
  request.mockReset().mockImplementation(async () => json({ items: [row], nextCursor: id }));
  await expect(createWorkspaceClient(request).projects(false)).rejects.toThrow("completed");
  expect(request).toHaveBeenCalledTimes(2);
});
it("rejects partial or malformed project permissions and inconsistent pages", async () => {
  for (const items of [
    [{ ...row, permissions: { canEdit: true } }],
    [row, row],
    [{ ...row, archived: true }],
    [{ ...row, revision: 0.5 }],
  ]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ items, nextCursor: null }));
    await expect(createWorkspaceClient(request).projects(false)).rejects.toThrow("verified");
  }
});
it("rechecks identity after obtaining CSRF, without submitting another account's change", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json({ requestToken: "token" }))
    .mockResolvedValueOnce(json({ ...session, userId: id }));
  expect(
    (
      await createWorkspaceClient(request).write(actor, `/api/v1/projects/${id}/archive`, "PATCH", {
        expectedRevision: 3,
        archived: true,
      })
    ).kind,
  ).toBe("rejected");
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it("sends the exact revision with CSRF and verifies the resulting account", async () => {
  const receipt = { projectId: id, revision: 4, archived: true, updatedAt: row.updatedAt };
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json({ requestToken: "token" }))
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json(receipt))
    .mockResolvedValueOnce(json(session));
  expect(
    await createWorkspaceClient(request).write(actor, `/api/v1/projects/${id}/archive`, "PATCH", {
      expectedRevision: 3,
      archived: true,
    }),
  ).toEqual({ kind: "confirmed", value: receipt });
  expect(request.mock.calls[3]?.[1]).toMatchObject({
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-CSRF-TOKEN": "token", "X-Spatia-Account": actor },
    body: JSON.stringify({ expectedRevision: 3, archived: true }),
  });
});
it("does not turn post-send failures or expired sessions into a safe retry", async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json({ requestToken: "token" }))
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(new Response(null, { status }));
    expect(
      await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {}),
    ).toEqual({
      kind: "unknown",
    });
    expect(request).toHaveBeenCalledTimes(4);
  }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(session))
    .mockResolvedValueOnce(json({ requestToken: "token" }))
    .mockResolvedValueOnce(json(session))
    .mockRejectedValueOnce(new Error("connection lost"));
  expect(await createWorkspaceClient(request).write(actor, "/api/v1/projects", "POST", {})).toEqual(
    {
      kind: "unknown",
    },
  );
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
