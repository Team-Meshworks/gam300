import { expect, it, vi } from "vitest";
import { createDashboardClient } from "./dashboard-client";

const actor = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const project = {
  projectId: actor,
  title: "History",
  revision: 0,
  updatedAt: "2026-11-03T00:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: true, canPublish: true },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

it("binds project reads and paginated archive requests to the signed-in administrator", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(json({ items: [project], nextCursor: null }));
  expect((await createDashboardClient(actor, request).projects(20, actor, true)).items).toEqual([
    project,
  ]);
  expect(String(request.mock.calls[0]?.[0])).toContain(`limit=20&archived=true&cursor=${actor}`);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    headers: { "X-Spatia-Account": actor },
    credentials: "same-origin",
    cache: "no-store",
  });
});

it("rejects untrusted project shapes before rendering project links or metadata", async () => {
  for (const invalid of [
    { ...project, projectId: "https://example.test" },
    { ...project, permissions: { canEdit: "yes" } },
    { ...project, updatedAt: "invalid" },
    { ...project, revision: -1 },
  ]) {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ items: [invalid], nextCursor: null }));
    await expect(createDashboardClient(actor, request).projects()).rejects.toThrow(
      "invalid details",
    );
  }
});

it("creates organisations with CSRF protection and the originating account on both requests", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(json({ id: actor, name: "School", isActive: true }, 201));
  await createDashboardClient(actor, request).createOrganization(" School ");
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Spatia-Account": actor });
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    headers: { "X-Spatia-Account": actor, "X-CSRF-TOKEN": "csrf" },
    body: JSON.stringify({ name: "School" }),
  });
});

it("does not submit an organisation with an invalid token or retry an uncertain creation", async () => {
  const invalidToken = vi.fn<typeof fetch>().mockResolvedValue(json({ requestToken: "" }));
  await expect(
    createDashboardClient(actor, invalidToken).createOrganization("School"),
  ).rejects.toThrow("verified");
  expect(invalidToken).toHaveBeenCalledTimes(1);
  const uncertain = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockRejectedValueOnce(new Error("network"));
  await expect(
    createDashboardClient(actor, uncertain).createOrganization("School"),
  ).rejects.toThrow("could not be confirmed");
  expect(uncertain).toHaveBeenCalledTimes(2);
});
