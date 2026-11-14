import { expect, it, vi } from "vitest";
import { createDashboardClient } from "./dashboard-client";

const actor = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const project = {
  projectId: actor,
  title: "History",
  revision: 0,
  updatedAt: "2026-11-03T00:00:00Z",
  archived: false,
  organizationName: "School",
  isPublic: false,
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
  expect(String(request.mock.calls[0]?.[0])).toContain(
    `limit=20&archived=true&published=true&cursor=${actor}`,
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    headers: { "X-Spatia-Account": actor },
    credentials: "same-origin",
    cache: "no-store",
  });
  const state = { projectId: actor, publicationCount: 2, hiddenCount: 1, publicCount: 1 };
  request.mockResolvedValueOnce(json({ items: [state] }));
  expect(
    await createDashboardClient(actor, request).publicationStates([actor, actor.toUpperCase()]),
  ).toEqual({ [actor]: state });
  expect(String(request.mock.calls[1]?.[0])).toContain(`ids=${actor}`);
  const ids = Array.from(
    { length: 101 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const bounded = vi.fn<typeof fetch>().mockImplementation(async (path) =>
    json({
      items: new URL(String(path), "https://local.test").searchParams
        .get("ids")!
        .split(",")
        .map((projectId) => ({ projectId, publicationCount: 0, hiddenCount: 0, publicCount: 0 })),
    }),
  );
  expect(
    Object.keys(await createDashboardClient(actor, bounded).publicationStates(ids)),
  ).toHaveLength(101);
  expect(bounded).toHaveBeenCalledTimes(2);
  expect(
    new URL(String(bounded.mock.calls[0]?.[0]), "https://local.test").searchParams
      .get("ids")!
      .split(","),
  ).toHaveLength(100);
});

it("rejects untrusted project shapes before rendering project links or metadata", async () => {
  for (const invalid of [
    { ...project, projectId: "https://example.test" },
    { ...project, permissions: { canEdit: "yes" } },
    { ...project, updatedAt: "invalid" },
    { ...project, revision: -1 },
    { ...project, isPublic: undefined },
    { ...project, isPublic: "public" },
    { ...project, organizationName: "" },
    { ...project, organizationName: "a".repeat(257) },
    { ...project, archived: true, isPublic: true },
  ]) {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ items: [invalid], nextCursor: null }));
    await expect(createDashboardClient(actor, request).projects()).rejects.toThrow(
      "invalid details",
    );
  }
  for (const items of [
    [],
    [{ projectId: actor, publicationCount: -1, hiddenCount: 0, publicCount: 0 }],
    [{ projectId: actor, publicationCount: 1, hiddenCount: 1, publicCount: 1 }],
    [{ projectId: "invalid", publicationCount: 1, hiddenCount: 0, publicCount: 1 }],
  ]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ items }));
    await expect(createDashboardClient(actor, request).publicationStates([actor])).rejects.toThrow(
      "could not be verified",
    );
  }
});

it("preserves draft moderation state and rejects malformed flags", async () => {
  const state = {
    projectId: actor,
    publicationCount: 0,
    hiddenCount: 0,
    publicCount: 0,
    publishingBlocked: true,
    removed: false,
  };
  const request = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [state] }));
  await expect(
    createDashboardClient(actor, request, "facilitator").publicationStates([actor]),
  ).resolves.toEqual({ [actor]: state });
  for (const invalid of [
    { ...state, publishingBlocked: "yes" },
    { ...state, removed: 1 },
  ]) {
    request.mockResolvedValueOnce(json({ items: [invalid] }));
    await expect(
      createDashboardClient(actor, request, "facilitator").publicationStates([actor]),
    ).rejects.toThrow("could not be verified");
  }
});

it("creates organisations with CSRF protection and the originating account on both requests", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(
      json(
        {
          id: actor,
          name: "School",
          isActive: true,
          projectCount: 0,
          facilitatorCount: 0,
          creatorCount: 0,
        },
        201,
      ),
    );
  await createDashboardClient(actor, request).createOrganization(" School ");
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Spatia-Account": actor });
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    headers: { "X-Spatia-Account": actor, "X-CSRF-TOKEN": "csrf" },
    body: JSON.stringify({ name: "School" }),
  });
  request
    .mockResolvedValueOnce(json({ requestToken: "fresh" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await createDashboardClient(actor, request).moderatePublications(project.projectId, "hide");
  expect(request.mock.calls[3]?.[1]).toMatchObject({
    method: "POST",
    headers: { "X-Spatia-Account": actor, "X-CSRF-TOKEN": "fresh" },
    body: JSON.stringify({ action: "hide" }),
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
  uncertain
    .mockResolvedValueOnce(json({ requestToken: "fresh" }))
    .mockRejectedValueOnce(new Error("network"));
  await expect(
    createDashboardClient(actor, uncertain).moderatePublications(actor, "delete"),
  ).rejects.toThrow("could not be confirmed");
  expect(uncertain).toHaveBeenCalledTimes(4);
});

it("resolves project class progress with authorised reads and rejects mismatched ownership", async () => {
  const organizationId = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
  let responseProject = project.projectId;
  let contexts: { classId: string; className: string; assignmentId: string }[] = [];
  let sourceProjectId = project.projectId;
  const details = () => ({
    assignmentId: actor,
    title: "History assignment",
    description: "Description",
    instructions: "Instructions",
    dueAtUnixSeconds: 2000000000,
    sourceProjectId,
    projects: [
      {
        studentId: organizationId,
        projectId: organizationId,
        studentName: "Student",
        approvalStatus: "approved",
        published: true,
      },
    ],
  });
  const request = vi.fn<typeof fetch>().mockImplementation(async (path) =>
    String(path).includes("/classes/")
      ? json(details())
      : String(path).endsWith("/assignments")
        ? json({ projectId: responseProject, organizationId, classAssignments: contexts })
        : json({
            items: [
              {
                id: organizationId,
                name: "School",
                isActive: true,
                projectCount: 0,
                facilitatorCount: 0,
                creatorCount: 0,
              },
            ],
            nextCursor: null,
          }),
  );
  const client = createDashboardClient(actor, request);
  await expect(client.projectDetails(project.projectId)).resolves.toEqual({
    organization: { id: organizationId, name: "School" },
    assignments: [],
  });
  contexts = [{ classId: actor, className: "4A", assignmentId: actor }];
  await expect(client.projectDetails(project.projectId)).resolves.toMatchObject({
    assignments: [{ classId: actor, className: "4A", details: details() }],
  });
  sourceProjectId = organizationId;
  await expect(client.projectDetails(project.projectId)).rejects.toThrow("could not be verified");
  sourceProjectId = project.projectId;
  for (const [, init] of request.mock.calls) {
    expect(init).toMatchObject({
      headers: { "X-Spatia-Account": actor },
      credentials: "same-origin",
      cache: "no-store",
    });
  }
  responseProject = organizationId;
  await expect(client.projectDetails(project.projectId)).rejects.toThrow("could not be verified");
});

it("sends a selected moderation action as one authenticated batch request", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "batch" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const ids = Array.from(
    { length: 25 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  await createDashboardClient(actor, request).moderatePublications(ids, "hide");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[0]).toBe("/api/v1/admin/projects/publication-moderation");
  expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
    projectIds: ids,
    action: "hide",
  });
});
