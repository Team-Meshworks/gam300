import { expect, it } from "vitest";
import { serveHttp } from "../../tests/http-fixture";
import { createAccountClient } from "../accounts/account-client";
import { createWorkspaceClient } from "../home/workspace-api";
import { withPublicationSession } from "./publication-session";

const userId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const publicationPath = "/api/v1/projects/44444444-4444-4444-8444-444444444444/publications";

async function publicationSession(initialOrgId: string, postPublicationOrgId = initialOrgId) {
  let activeOrgId = initialOrgId;
  const server = await serveHttp((request) => {
    switch (new URL(request.url).pathname) {
      case "/api/v1/auth/session":
        return Response.json({
          userId,
          orgId: activeOrgId,
          role: "Educator",
          displayName: "Teacher",
          mustChangePassword: false,
        });
      case "/api/v1/auth/csrf":
        return Response.json({ requestToken: "token" });
      case publicationPath:
        activeOrgId = postPublicationOrgId;
        return Response.json("receipt", { status: 201 });
      default:
        return new Response(null, { status: 404 });
    }
  });
  const { getSession } = createAccountClient(server.fetch);
  const { write } = createWorkspaceClient(server.fetch);
  return {
    run: () =>
      withPublicationSession({ userId, orgId }, getSession, () =>
        write(userId, publicationPath, "POST"),
      ),
    writes: () => server.requests.filter((request) => request.method === "POST"),
  };
}

it("does not send a publication step after the organisation changes", async () => {
  const flow = await publicationSession(otherOrgId);
  expect(await flow.run()).toEqual({ kind: "unknown" });
  expect(flow.writes()).toHaveLength(0);
});

it("treats a response after an organisation switch as uncertain", async () => {
  const flow = await publicationSession(orgId, otherOrgId);
  expect(await flow.run()).toEqual({ kind: "unknown" });
  expect(flow.writes()).toHaveLength(1);
});

it("accepts a confirmed result only while the same educator session remains active", async () => {
  const flow = await publicationSession(orgId);
  expect(await flow.run()).toEqual({ kind: "confirmed", value: "receipt" });
  expect(flow.writes()).toHaveLength(1);
});
