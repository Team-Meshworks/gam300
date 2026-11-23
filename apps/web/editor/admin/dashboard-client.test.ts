import { afterEach, beforeEach, expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
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
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

it("binds project reads and paginated archive requests to the signed-in administrator", async () => {
  const state = { projectId: actor, publicationCount: 2, hiddenCount: 1, publicCount: 1 };
  const request = await serveResponses(
    json({ items: [project], nextCursor: null }),
    json({ items: [state] }),
  );
  expect(
    (await createDashboardClient(actor, request.fetch).projects(20, actor, true)).items,
  ).toEqual([project]);
  expect(new URL(request.requests[0]!.url).search).toContain(
    `limit=20&archived=true&published=true&cursor=${actor}`,
  );
  expect(request.requests[0]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
  });
  expect(request.requests[0]?.headers.get("X-Spatia-Account")).toBe(actor);
  expect(
    await createDashboardClient(actor, request.fetch).publicationStates([
      actor,
      actor.toUpperCase(),
    ]),
  ).toEqual({ [actor]: state });
  expect(new URL(request.requests[1]!.url).search).toContain(`ids=${actor}`);
  const ids = Array.from(
    { length: 101 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const bounded = await serveHttp(async (incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const path = pathname + search;
    return json({
      items: new URL(String(path), "https://local.test").searchParams
        .get("ids")!
        .split(",")
        .map((projectId) => ({ projectId, publicationCount: 0, hiddenCount: 0, publicCount: 0 })),
    });
  });
  expect(
    Object.keys(await createDashboardClient(actor, bounded.fetch).publicationStates(ids)),
  ).toHaveLength(101);
  expect(bounded.requests).toHaveLength(2);
  expect(new URL(bounded.requests[0]!.url).searchParams.get("ids")!.split(",")).toHaveLength(100);
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
    const request = await serveResponses(json({ items: [invalid], nextCursor: null }));
    await expect(createDashboardClient(actor, request.fetch).projects()).rejects.toThrow(
      "invalid details",
    );
  }
  for (const items of [
    [],
    [{ projectId: actor, publicationCount: -1, hiddenCount: 0, publicCount: 0 }],
    [{ projectId: actor, publicationCount: 1, hiddenCount: 1, publicCount: 1 }],
    [{ projectId: "invalid", publicationCount: 1, hiddenCount: 0, publicCount: 1 }],
  ]) {
    const request = await serveResponses(json({ items }));
    await expect(
      createDashboardClient(actor, request.fetch).publicationStates([actor]),
    ).rejects.toThrow("could not be verified");
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
  const request = await serveResponses(
    json({ items: [state] }),
    json({ items: [{ ...state, publishingBlocked: "yes" }] }),
    json({ items: [{ ...state, removed: 1 }] }),
  );
  await expect(
    createDashboardClient(actor, request.fetch, "facilitator").publicationStates([actor]),
  ).resolves.toEqual({ [actor]: state });
  for (let index = 0; index < 2; index++) {
    await expect(
      createDashboardClient(actor, request.fetch, "facilitator").publicationStates([actor]),
    ).rejects.toThrow("could not be verified");
  }
});

it("creates organisations with CSRF protection and the originating account on both requests", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
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
    json({ requestToken: "fresh" }),
    new Response(null, { status: 204 }),
  );
  const client = createDashboardClient(actor, request.fetch);
  await expect(client.createOrganization(" School ")).resolves.toBe(actor);
  expect(request.requests[0]?.headers.get("X-Spatia-Account")).toBe(actor);
  const create = request.requests[1]!;
  expect(create.method).toBe("POST");
  expect(create.headers.get("X-Spatia-Account")).toBe(actor);
  expect(create.headers.get("X-CSRF-TOKEN")).toBe("csrf");
  expect(await create.json()).toEqual({ name: "School" });
  await client.moderatePublications(project.projectId, "hide");
  const moderation = request.requests[3]!;
  expect(moderation.method).toBe("POST");
  expect(moderation.headers.get("X-Spatia-Account")).toBe(actor);
  expect(moderation.headers.get("X-CSRF-TOKEN")).toBe("fresh");
  expect(await moderation.json()).toEqual({ action: "hide" });
});

it("does not submit an organisation with an invalid token or retry an uncertain creation", async () => {
  const invalidToken = await serveResponses(json({ requestToken: "" }));
  await expect(
    createDashboardClient(actor, invalidToken.fetch).createOrganization("School"),
  ).rejects.toThrow("verified");
  expect(invalidToken.requests).toHaveLength(1);
  const uncertain = await serveResponses(
    json({ requestToken: "csrf" }),
    Response.error(),
    json({ requestToken: "fresh" }),
    Response.error(),
  );
  await expect(
    createDashboardClient(actor, uncertain.fetch).createOrganization("School"),
  ).rejects.toThrow("could not be confirmed");
  expect(uncertain.requests).toHaveLength(2);
  await expect(
    createDashboardClient(actor, uncertain.fetch).moderatePublications(actor, "delete"),
  ).rejects.toThrow("could not be confirmed");
  expect(uncertain.requests).toHaveLength(4);
});

it("keeps a committed organisation with a lost reply from being created again after reopening", async () => {
  const created: string[] = [];
  const request = await serveHttp(async (incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const path = pathname + search;
    if (path === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    const value: unknown = await incoming.json();
    if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
      return new Response(null, { status: 400 });
    created.push(value.name);
    return Response.error();
  });
  await expect(
    createDashboardClient(actor, request.fetch).createOrganization("School"),
  ).rejects.toThrow();
  await expect(
    createDashboardClient(actor, request.fetch).createOrganization("School"),
  ).rejects.toThrow();
  expect(created).toEqual(["School"]);
});

it("keeps an uncertain creation when another tab acknowledges a superseded attempt", async () => {
  const request = await serveHttp(async (incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const path = pathname + search;

    if (path === "/api/v1/auth/csrf") return json({ requestToken: "csrf" });
    if (String(path).startsWith("/api/v1/admin/organizations?"))
      return json({ items: [], nextCursor: null });
    return new Response(null, { status: 503 });
  });
  const client = createDashboardClient(actor, request.fetch);
  await expect(client.createOrganization("First School")).rejects.toThrow("confirmed");
  const first = client.pendingOrganization()!;
  await client.acknowledgeOrganization(first);
  await expect(client.createOrganization("Another School")).rejects.toThrow("confirmed");
  await expect(client.acknowledgeOrganization(first)).rejects.toThrow("changed");
  expect(client.pendingOrganization()?.name).toBe("Another School");
});

it("accepts the existing active organisation returned to another profile and releases a definite name conflict", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
    json({ id: actor, name: "  NORTH School ", isActive: true }, 200),
    json({ requestToken: "csrf" }),
    json({ code: "organization_name_in_use" }, 409),
  );
  const client = createDashboardClient(actor, request.fetch);
  await client.createOrganization("North School");
  expect(client.pendingOrganization()).toBeNull();
  await expect(client.createOrganization("Old campus")).rejects.toThrow("directory");
  expect(client.pendingOrganization()).toBeNull();
  expect(request.requests).toHaveLength(4);
});

it("unlocks a definite rejection and keeps a mismatched confirmation for review", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
    new Response(null, { status: 400 }),
    json({ requestToken: "csrf" }),
    json({ id: actor, name: "Another school", isActive: true }, 201),
  );
  const client = createDashboardClient(actor, request.fetch);
  await expect(client.createOrganization("School")).rejects.toThrow("name");
  expect(client.pendingOrganization()).toBeNull();
  await expect(client.createOrganization("School")).rejects.toThrow("confirmed");
  expect(client.pendingOrganization()?.name).toBe("School");
});

it("lets the administrator reconcile an unreadable marker without sending or clearing a replacement", async () => {
  const key = `spatia.organization-create:${actor}`;
  const request = await serveResponses(json({ items: [], nextCursor: null }));
  const client = createDashboardClient(actor, request.fetch);
  localStorage.setItem(key, "{partial");
  const earlier = client.pendingOrganization()!;
  expect(earlier.name).toBeNull();
  await expect(client.createOrganization("School")).rejects.toThrow("directory");
  expect(request.requests).toHaveLength(0);
  localStorage.setItem(key, "newer marker");
  await expect(client.acknowledgeOrganization(earlier)).rejects.toThrow("changed");
  const replacement = client.pendingOrganization()!;
  await client.acknowledgeOrganization(replacement);
  expect(client.pendingOrganization()).toBeNull();
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
  const request = await serveHttp(async (incoming) => {
    const { pathname, search } = new URL(incoming.url);
    const path = pathname + search;
    return String(path).includes("/classes/")
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
          });
  });
  const client = createDashboardClient(actor, request.fetch);
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
  for (const read of request.requests) {
    expect(read).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(read.headers.get("X-Spatia-Account")).toBe(actor);
  }
  responseProject = organizationId;
  await expect(client.projectDetails(project.projectId)).rejects.toThrow("could not be verified");
});

it("sends a selected moderation action as one authenticated batch request", async () => {
  const request = await serveResponses(
    json({ requestToken: "batch" }),
    new Response(null, { status: 204 }),
  );
  const ids = Array.from(
    { length: 25 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  await createDashboardClient(actor, request.fetch).moderatePublications(ids, "hide");
  expect(request.requests).toHaveLength(2);
  const batch = request.requests[1]!;
  expect(new URL(batch.url).pathname).toBe("/api/v1/admin/projects/publication-moderation");
  expect(await batch.json()).toEqual({
    projectIds: ids,
    action: "hide",
  });
});

it("retains an organisation attempt when its dispatched write returns 401", async () => {
  const request = await serveResponses(json({ requestToken: "csrf" }), json({}, 401));
  const client = createDashboardClient(actor, request.fetch);
  await expect(client.createOrganization("School")).rejects.toThrow();
  expect(client.pendingOrganization()?.name).toBe("School");
});

it.each([401, 403])(
  "does not create an organisation marker when preflight returns %s",
  async (status) => {
    const request = await serveResponses(json({}, status));
    const client = createDashboardClient(actor, request.fetch);
    await expect(client.createOrganization("School")).rejects.toThrow();
    expect(client.pendingOrganization()).toBeNull();
    expect(request.requests).toHaveLength(1);
  },
);

it("does not clear an organisation attempt without an authorized directory read", async () => {
  const request = await serveResponses(json({}, 401));
  const client = createDashboardClient(actor, request.fetch);
  localStorage.setItem(
    `spatia.organization-create:${actor}`,
    JSON.stringify({ attemptId: actor, name: "School" }),
  );
  await expect(client.acknowledgeOrganization(client.pendingOrganization()!)).rejects.toThrow();
  expect(client.pendingOrganization()?.name).toBe("School");
});

it("does not dispatch an organisation create when the recovery marker cannot be stored", async () => {
  localStorage.setItem("q", "x".repeat(5 * 1024 * 1024 - 1));
  const request = await serveResponses(json({ requestToken: "csrf" }));
  await expect(
    createDashboardClient(actor, request.fetch).createOrganization("School"),
  ).rejects.toThrow();
  expect(request.requests).toHaveLength(1);
});
