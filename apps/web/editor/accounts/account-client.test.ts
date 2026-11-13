import { expect, it, vi } from "vitest";
import { createAccountClient } from "./account-client";

const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Teacher",
  role: "Educator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  orgName: "Test school",
  mustChangePassword: false,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

it.each([
  [true, true],
  [false, false],
  [undefined, false],
  ["true", false],
  [null, false],
])("permits bundled assets only for a literal true capability (%s)", async (value, expected) => {
  const response = {
    ...session,
    ...(value === undefined ? {} : { developmentAssetsAllowed: value }),
  };
  const client = createAccountClient(vi.fn<typeof fetch>().mockResolvedValue(json(response)));
  expect(await client.getSession()).toMatchObject({ developmentAssetsAllowed: expected });
});

it("signs in with CSRF and verifies the session after rotating the request token", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "anonymous-token" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(json({ requestToken: "account-token" }))
    .mockResolvedValueOnce(json(session));
  const client = createAccountClient(request);
  expect(await client.signIn("teacher", " password unchanged ")).toEqual({
    ...session,
    developmentAssetsAllowed: false,
  });
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/auth/login",
    "/api/v1/auth/csrf",
    "/api/v1/auth/session",
  ]);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": "anonymous-token" },
    body: JSON.stringify({ userName: "teacher", password: " password unchanged " }),
  });
});
it("reports a rejected login without inventing a session", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "token" }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(createAccountClient(request).signIn("teacher", "wrong password")).rejects.toThrow(
    "username or password",
  );
  expect(request).toHaveBeenCalledTimes(2);
});
it("rejects malformed and unsupported sessions", async () => {
  for (const value of [
    { ...session, role: "Superuser" },
    { ...session, orgId: null },
    { ...session, mustChangePassword: "false" },
  ]) {
    await expect(
      createAccountClient(vi.fn<typeof fetch>().mockResolvedValue(json(value))).getSession(),
    ).rejects.toThrow("session");
  }
});
it("treats expired sessions as signed out and HTML as an unavailable API", async () => {
  expect(
    await createAccountClient(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    ).getSession(),
  ).toBeNull();
  await expect(
    createAccountClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("<html>editor</html>", { headers: { "Content-Type": "text/html" } }),
        ),
    ).getSession(),
  ).rejects.toThrow("unavailable");
});
it("changes a forced password then fetches authoritative session state", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "old" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(json({ requestToken: "new" }))
    .mockResolvedValueOnce(json(session));
  expect(
    await createAccountClient(request).changePassword("old password value", "new password value"),
  ).toEqual({ ...session, developmentAssetsAllowed: false });
  expect(request.mock.calls[1]).toEqual([
    "/api/v1/auth/password",
    expect.objectContaining({
      body: JSON.stringify({
        currentPassword: "old password value",
        newPassword: "new password value",
      }),
    }),
  ]);
});
it("only confirms logout after a fresh session check returns signed out", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ requestToken: "old" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(json({ requestToken: "new" }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(createAccountClient(request).signOut()).resolves.toBeUndefined();
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/auth/logout",
    "/api/v1/auth/csrf",
    "/api/v1/auth/session",
  ]);
});

it("binds logout token and mutation to the original account across a cookie switch", async () => {
  let cookie = session.userId;
  const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (url === "/api/v1/auth/csrf") {
      expect(new Headers(init?.headers).get("X-Spatia-Account")).toBe(session.userId);
      cookie = "another-account";
      return json({ requestToken: "old-token" });
    }
    expect(url).toBe("/api/v1/auth/logout");
    expect(new Headers(init?.headers).get("X-Spatia-Account")).not.toBe(cookie);
    return new Response(null, { status: 403 });
  });
  await expect(createAccountClient(request).signOut(session.userId)).rejects.toThrow();
  expect(cookie).toBe("another-account");
  expect(request).toHaveBeenCalledTimes(2);
});
