import { expect, it } from "vitest";
import { deferred } from "../../tests/deferred";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import { createAccountClient, type AccountSession } from "./account-client";
import { createWorkspaceAccount } from "./workspace-account";

const user: AccountSession = {
  userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
  orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
  displayName: "Ms Tan",
  role: "Educator",
  mustChangePassword: false,
  developmentAssetsAllowed: false,
};

it("retains a same-account workspace across a password challenge but drops it for another organisation", async () => {
  const http = await serveResponses(
    Response.json(user),
    Response.json({ ...user, mustChangePassword: true }),
    Response.json({
      ...user,
      mustChangePassword: true,
      orgId: "12e5c301-311c-40ff-b81a-2087c87420bb",
    }),
  );
  const account = createWorkspaceAccount(createAccountClient(http.fetch));
  await account.check();
  await account.check();
  expect(account.getSnapshot()).toEqual({
    kind: "password-required",
    workspace: user,
  });
  await account.check();
  expect(account.getSnapshot()).toEqual({
    kind: "password-required",
    workspace: null,
  });
});

it("rejects a stale logout and sends just one account-bound write, even during a focus check", async () => {
  const logoutArrived = deferred<void>();
  const finishLogout = deferred<void>();
  let signedOut = false;
  const http = await serveHttp(async (request) => {
    switch (new URL(request.url).pathname) {
      case "/api/v1/auth/session":
        return signedOut ? new Response(null, { status: 401 }) : Response.json(user);
      case "/api/v1/auth/csrf":
        return Response.json({ requestToken: "token" });
      case "/api/v1/auth/logout":
        logoutArrived.resolve();
        await finishLogout.promise;
        signedOut = true;
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 404 });
    }
  });
  const account = createWorkspaceAccount(createAccountClient(http.fetch));
  await account.check();
  await account.signOut({ ...user, role: "Creator" });
  expect(http.requests).toHaveLength(1);
  const pending = account.signOut(user);
  try {
    await Promise.race([logoutArrived.promise, pending]);
    await account.signOut(user);
    await account.check();
    expect(account.getSnapshot().kind).toBe("signing-out");
    expect(http.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/auth/session",
      "/api/v1/auth/csrf",
      "/api/v1/auth/logout",
    ]);
    expect(http.requests[2]?.headers.get("X-Spatia-Account")).toBe(user.userId);
  } finally {
    finishLogout.resolve();
    await pending;
  }
  expect(account.getSnapshot()).toEqual({
    kind: "signed-out",
    workspace: null,
  });
});

it("retains unchanged identity after verification and propagates changed account capabilities", async () => {
  const http = await serveResponses(
    Response.json(user),
    Response.json(user),
    Response.json({ ...user, developmentAssetsAllowed: true }),
  );
  const account = createWorkspaceAccount(createAccountClient(http.fetch));
  await account.check();
  const original = account.getSnapshot().workspace;
  await account.check();
  expect(http.requests).toHaveLength(2);
  expect(account.getSnapshot().workspace).toBe(original);
  await account.check();
  expect(account.getSnapshot().workspace).not.toBe(original);
  expect(account.getSnapshot().workspace?.developmentAssetsAllowed).toBe(true);
});
