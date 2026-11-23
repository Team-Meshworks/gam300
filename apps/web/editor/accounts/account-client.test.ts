import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { createAccountClient } from "./account-client";

const session = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  displayName: "Teacher",
  role: "Educator",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  orgName: "Test school",
  mustChangePassword: false,
};

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
  const http = await serveResponses(Response.json(response));
  expect(await createAccountClient(http.fetch).getSession()).toMatchObject({
    developmentAssetsAllowed: expected,
  });
});

it("signs in with CSRF and verifies the session after rotating the request token", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "anonymous-token" }),
    new Response(null, { status: 204 }),
    Response.json({ requestToken: "account-token" }),
    Response.json(session),
  );
  expect(await createAccountClient(http.fetch).signIn("teacher", " password unchanged ")).toEqual({
    ...session,
    developmentAssetsAllowed: false,
  });
  expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/auth/login",
    "/api/v1/auth/csrf",
    "/api/v1/auth/session",
  ]);
  const login = http.requests[1]!;
  expect(login).toMatchObject({ method: "POST", credentials: "same-origin" });
  expect(login.headers.get("X-CSRF-TOKEN")).toBe("anonymous-token");
  expect(await login.json()).toEqual({ userName: "teacher", password: " password unchanged " });
});

it("reports a rejected login without inventing a session", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "token" }),
    new Response(null, { status: 401 }),
  );
  await expect(createAccountClient(http.fetch).signIn("teacher", "wrong password")).rejects.toThrow(
    "username or password",
  );
  expect(http.requests).toHaveLength(2);
});

it("rejects malformed and unsupported sessions", async () => {
  for (const invalid of [
    { ...session, role: "Superuser" },
    { ...session, role: ["Educator"] },
    { ...session, orgId: null },
    { ...session, mustChangePassword: "false" },
  ]) {
    const http = await serveResponses(Response.json(invalid));
    await expect(createAccountClient(http.fetch).getSession()).rejects.toThrow("session");
  }
});

it("treats expired sessions as signed out and HTML as an unavailable API", async () => {
  const http = await serveResponses(
    new Response(null, { status: 401 }),
    new Response("<html>editor</html>", { headers: { "Content-Type": "text/html" } }),
  );
  const client = createAccountClient(http.fetch);
  expect(await client.getSession()).toBeNull();
  await expect(client.getSession()).rejects.toThrow("unavailable");
});

it("changes a forced password then fetches authoritative session state", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "old" }),
    new Response(null, { status: 204 }),
    Response.json({ requestToken: "new" }),
    Response.json(session),
  );
  const input = { currentPassword: "old password value", newPassword: "new password value" };
  expect(
    await createAccountClient(http.fetch).changePassword(
      input.currentPassword,
      input.newPassword,
      session.userId,
    ),
  ).toEqual({ ...session, developmentAssetsAllowed: false });
  const change = http.requests[1]!;
  expect(new URL(change.url).pathname).toBe("/api/v1/auth/password");
  expect(await change.json()).toEqual(input);
});

it("binds a forced-password change and its confirmation to the displayed account", async () => {
  const changed = { ...session, userId: "6d0d9b7f-6851-4dc6-91e4-d41aadd299be" };
  const http = await serveResponses(
    Response.json({ requestToken: "token" }),
    new Response(null, { status: 204 }),
    Response.json({ requestToken: "new" }),
    Response.json(changed),
  );
  await expect(
    createAccountClient(http.fetch).changePassword(
      "old password value",
      "new password value",
      session.userId,
    ),
  ).rejects.toThrow("updated session");
  for (const { headers } of http.requests.slice(0, 2)) {
    expect(headers.get("X-Spatia-Account")).toBe(session.userId);
  }
});

it("only confirms logout after a fresh session check returns signed out", async () => {
  const http = await serveResponses(
    Response.json({ requestToken: "old" }),
    new Response(null, { status: 204 }),
    Response.json({ requestToken: "new" }),
    new Response(null, { status: 401 }),
  );
  await expect(createAccountClient(http.fetch).signOut(session.userId)).resolves.toBeUndefined();
  expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/auth/logout",
    "/api/v1/auth/csrf",
    "/api/v1/auth/session",
  ]);
});

it("binds logout token and mutation to the original account across a cookie switch", async () => {
  let activeAccount = session.userId;
  const http = await serveHttp((request) => {
    switch (new URL(request.url).pathname) {
      case "/api/v1/auth/csrf":
        activeAccount = "another-account";
        return Response.json({ requestToken: "old-token" });
      case "/api/v1/auth/logout":
        return new Response(null, {
          status: request.headers.get("X-Spatia-Account") === activeAccount ? 204 : 403,
        });
      default:
        return new Response(null, { status: 404 });
    }
  });
  await expect(createAccountClient(http.fetch).signOut(session.userId)).rejects.toThrow(
    "account change could not be completed",
  );
  expect(activeAccount).toBe("another-account");
  expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
    "/api/v1/auth/csrf",
    "/api/v1/auth/logout",
  ]);
  for (const { headers } of http.requests) {
    expect(headers.get("X-Spatia-Account")).toBe(session.userId);
  }
});
