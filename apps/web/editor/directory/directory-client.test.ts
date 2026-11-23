import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { createDirectoryClient } from "./directory-client";

const user = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Aisyah Abdullah",
  userName: "aisyah",
  role: "Creator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  isActive: true,
  mustChangePassword: true,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
it("loads every page within the selected organisation", async () => {
  const organization = {
    id: user.orgId,
    name: "School",
    isActive: true,
    projectCount: 2,
    facilitatorCount: 1,
    creatorCount: 3,
  };

  const project = { id: user.userId, title: "Project", status: "Draft", isPublic: true };
  const request = await serveResponses(
    json({ items: [user], nextCursor: user.userId }),
    json({ items: [], nextCursor: null }),
    json({ items: [organization], nextCursor: null }),
    json({ items: [project], nextCursor: null }),
  );
  expect(await createDirectoryClient(request.fetch).accounts(user.orgId)).toEqual([user]);
  expect(new URL(request.requests[1]!.url).search).toBe(
    `?orgId=${user.orgId}&limit=100&cursor=${user.userId}`,
  );
  expect(request.requests[0]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  expect(
    await createDirectoryClient(request.fetch, user.userId).organizations("Aisyah 100%_ School"),
  ).toEqual([organization]);
  expect(new URL(request.requests[2]!.url).search).toBe("?q=Aisyah%20100%25_%20School&limit=100");
  expect(request.requests[2]?.headers.get("X-Spatia-Account")).toBe(user.userId);
  expect(await createDirectoryClient(request.fetch, user.userId).projects(user.orgId)).toEqual([
    project,
  ]);
});
it("sends only overridden fields with a fresh CSRF token", async () => {
  const request = await serveResponses(json({ requestToken: "csrf" }), json(user));
  await createDirectoryClient(request.fetch).update(user.userId, {
    displayName: "Aisyah Abdullah",
  });
  const mutation = request.requests[1]!;
  expect(mutation.method).toBe("PATCH");
  expect(mutation.headers.get("X-CSRF-TOKEN")).toBe("csrf");
  expect(await mutation.json()).toEqual({ displayName: "Aisyah Abdullah" });
});
it("reports duplicate usernames without returning a successful account", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
    json({ code: "username_taken" }, 409),
  );
  await expect(
    createDirectoryClient(request.fetch).create(user.orgId, {
      displayName: user.displayName,
      userName: user.userName,
      role: "Creator",
      initialPassword: "Synthetic-password1!",
    }),
  ).rejects.toThrow("already taken");
});
it("rejects malformed accounts, repeated cursors and unverified CSRF responses", async () => {
  const invalid = await serveResponses(json({ ...user, role: "Superuser" }));
  await expect(createDirectoryClient(invalid.fetch).getAccount(user.userId)).rejects.toThrow(
    "invalid account",
  );
  const repeated = await serveHttp(async () => json({ items: [user], nextCursor: user.userId }));
  await expect(createDirectoryClient(repeated.fetch).accounts(user.orgId)).rejects.toThrow(
    "finish loading",
  );
  const csrf = await serveResponses(json({ requestToken: "" }));
  await expect(
    createDirectoryClient(csrf.fetch).update(user.userId, { displayName: "Name" }),
  ).rejects.toThrow("verified");
  expect(csrf.requests).toHaveLength(1);
  const malformedTotals = await serveResponses(
    json({
      items: [
        {
          id: user.orgId,
          name: "School",
          isActive: true,
          projectCount: -1,
          facilitatorCount: 0,
          creatorCount: 1,
        },
      ],
      nextCursor: null,
    }),
  );
  await expect(createDirectoryClient(malformedTotals.fetch).organizations()).rejects.toThrow(
    "Invalid organisation",
  );
});
it("does not retry an unconfirmed write automatically", async () => {
  const request = await serveResponses(json({ requestToken: "csrf" }), Response.error());
  await expect(
    createDirectoryClient(request.fetch).update(user.userId, { userName: "new" }),
  ).rejects.toThrow("refresh the directory");
  expect(request.requests).toHaveLength(2);
});

const deletion = {
  id: user.orgId,
  name: "Ridgeview",
  accounts: 3,
  classes: 1,
  assignments: 2,
  projects: 4,
  submissions: 2,
  reviews: 1,
  publications: 1,
};
it("loads deletion counts and requires a valid summary for the selected organisation", async () => {
  const invalid = [
    { ...deletion, id: user.userId },
    { ...deletion, accounts: -1 },
    { ...deletion, projects: 0.5 },
    { ...deletion, publications: null },
  ];
  const request = await serveResponses(json(deletion), ...invalid.map((value) => json(value)));
  const client = createDirectoryClient(request.fetch);
  expect(await client.deletion(user.orgId)).toEqual(deletion);
  for (const _value of invalid) {
    await expect(client.deletion(user.orgId)).rejects.toThrow("deletion details");
  }
});
it("binds deletion and its fresh CSRF token to the administrator who opened the screen", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
    new Response(null, { status: 204 }),
  );
  await createDirectoryClient(request.fetch, user.userId).deleteOrganization(
    user.orgId,
    deletion.name,
  );
  expect(request.requests[0]?.headers.get("X-Spatia-Account")).toBe(user.userId);
  const mutation = request.requests[1]!;
  expect(new URL(mutation.url).pathname).toBe(`/api/v1/admin/organizations/${user.orgId}/deletion`);
  expect(mutation).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  expect(mutation.headers.get("Content-Type")).toBe("application/json");
  expect(mutation.headers.get("X-CSRF-TOKEN")).toBe("csrf");
  expect(mutation.headers.get("X-Spatia-Account")).toBe(user.userId);
  expect(await mutation.json()).toEqual({ confirmationName: deletion.name });
});
it("reports deletion conflicts and never retries an uncertain delete", async () => {
  const request = await serveResponses(
    json({ requestToken: "csrf" }),
    json({ code: "organization_delete_conflict" }, 409),
    json({ requestToken: "csrf" }),
    Response.error(),
    json({ requestToken: "csrf" }),
    Response.error(),
  );
  const client = createDirectoryClient(request.fetch);
  await expect(client.deleteOrganization(user.orgId, deletion.name)).rejects.toThrow(
    "Nothing was deleted",
  );
  await expect(client.deleteOrganization(user.orgId, deletion.name)).rejects.toThrow(
    "Deletion could not be confirmed",
  );
  expect(request.requests).toHaveLength(4);
  await expect(client.deleteAccount(user.userId)).rejects.toThrow(
    "Deletion could not be confirmed",
  );
  expect(request.requests).toHaveLength(6);
  expect(request.requests[5]).toMatchObject({ method: "DELETE" });
});
it.each([200, 404, 405])(
  "requires a confirmed deletion without falling back on HTTP %d",
  async (status) => {
    const request = await serveResponses(json({ requestToken: "csrf" }), json({}, status));
    await expect(
      createDirectoryClient(request.fetch, user.userId).deleteOrganization(
        user.orgId,
        deletion.name,
      ),
    ).rejects.toThrow();
    expect(request.requests).toHaveLength(2);
    expect(request.requests[1]?.method).toBe("POST");
  },
);
