import { expect, it } from "vitest";
import { serveHttp } from "../../tests/http-fixture";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { createReviewClient } from "./review-client";
import { educatorReviewLink } from "./educator-review-link";

const projectId = "11111111-1111-4111-8111-111111111111";
const classId = "22222222-2222-4222-8222-222222222222";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const studentId = "44444444-4444-4444-8444-444444444444";
const session: AccountSession = {
  userId: "55555555-5555-4555-8555-555555555555",
  orgId: "66666666-6666-4666-8666-666666666666",
  role: "Educator",
  displayName: "Teacher",
  mustChangePassword: false,
};
async function reviewLinkServer({
  includeClass = true,
  includeProject = true,
  finalSession = session,
} = {}) {
  let activeSession = session;
  const server = await serveHttp((request) => {
    switch (new URL(request.url).pathname) {
      case "/api/v1/auth/session":
        return Response.json(activeSession);
      case `/api/v1/projects/${projectId}/submissions`:
        return Response.json({ projectId, classId, assignmentId });
      case "/api/v1/classes":
        return Response.json({
          items: includeClass ? [{ id: classId, name: "Class" }] : [],
          nextCursor: null,
        });
      case `/api/v1/classes/${classId}/assignments`:
        activeSession = finalSession;
        return Response.json({
          items: [
            {
              assignmentId,
              title: "Assignment",
              dueAtUnixSeconds: 1,
              projects: includeProject ? [{ projectId, studentId }] : [],
            },
          ],
          nextCursor: null,
        });
      default:
        return new Response(null, { status: 404 });
    }
  });
  const client = createReviewClient(server.fetch);
  const { getSession } = createAccountClient(server.fetch);
  return { client, getSession, requests: server.requests };
}
it("opens the exact assigned student's editor review", async () => {
  const { client, getSession } = await reviewLinkServer();
  const url = new URL(
    await educatorReviewLink(projectId, session, client, getSession),
    "https://example.test",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    projectId,
    classId,
    assignmentId,
    studentId,
    review: "1",
  });
});
it("does not open a project removed from the assignment", async () => {
  const { client, getSession } = await reviewLinkServer({ includeProject: false });
  await expect(educatorReviewLink(projectId, session, client, getSession)).rejects.toThrow(
    "no longer available",
  );
});
it("does not open a class outside the current account's class list", async () => {
  const { client, getSession } = await reviewLinkServer({ includeClass: false });
  await expect(educatorReviewLink(projectId, session, client, getSession)).rejects.toThrow(
    "linked class is unavailable",
  );
});
it.each(["userId", "orgId", "role"] as const)(
  "rejects a changed %s after lookup",
  async (field) => {
    const { client, getSession } = await reviewLinkServer({
      finalSession: { ...session, [field]: field === "role" ? "Creator" : studentId },
    });
    await expect(educatorReviewLink(projectId, session, client, getSession)).rejects.toThrow(
      "account changed",
    );
  },
);
it("rejects Creator links before reading review records", async () => {
  const { client, getSession, requests } = await reviewLinkServer();
  await expect(
    educatorReviewLink(projectId, { ...session, role: "Creator" }, client, getSession),
  ).rejects.toThrow("invalid");
  expect(requests).toHaveLength(0);
});
