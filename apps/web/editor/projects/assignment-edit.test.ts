import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import {
  editDeadline,
  supersededAssignment,
  submitAssignmentEdit,
  type PendingAssignmentEdit,
} from "./assignment-edit";

const request: PendingAssignmentEdit = {
  actorId: "teacher",
  classId: "class",
  assignmentId: "assignment",
  body: {
    mutationId: "edit-1",
    expectedRevision: 2,
    title: "Revised",
    description: "Description",
    instructions: "Instructions",
    dueAtUnixSeconds: 2_000_000_000,
    studentIds: ["alice"],
  },
};
const json = (data: object, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const session = () =>
  json({
    userId: "teacher",
    displayName: "Teacher",
    role: "Educator",
    orgId: "school",
    mustChangePassword: false,
  });

it("preserves the exact deadline when the date is unchanged", () => {
  expect(editDeadline("2033-05-18T10:20", "2033-05-18T10:20", 2_000_000_000)).toBe(2_000_000_000);
  expect(editDeadline("2027-01-12T14:30", "2027-01-12T10:00", 2_000_000_000)).toBe(
    new Date("2027-01-12T14:30").getTime() / 1000,
  );
});

it("only permits recovery when the current revision supersedes the uncertain request", () => {
  expect(supersededAssignment(request, { assignmentId: "assignment", revision: 3 })).toBe(true);
  expect(supersededAssignment(request, { assignmentId: "assignment", revision: 2 })).toBe(false);
  expect(supersededAssignment(request, { assignmentId: "other", revision: 3 })).toBe(false);
});

it("retries an uncertain edit with the same identity and body", async () => {
  const { fetch: fetcher, requests } = await serveResponses(
    session(),
    json({ requestToken: "csrf" }),
    session(),
    Response.error(),
    session(),
    json({ requestToken: "csrf" }),
    session(),
    json({ assignmentId: "assignment", revision: 3 }),
    session(),
  );
  expect(await submitAssignmentEdit(request, false, fetcher)).toEqual({ kind: "unknown" });
  expect(await submitAssignmentEdit(request, true, fetcher)).toEqual({ kind: "confirmed" });
  const original = await requests[3]!.text();
  expect(original).toBe(await requests[7]!.text());
  expect(JSON.parse(original)).toEqual(request.body);
});

it("only unlocks a known first conflict; later denials cannot resolve an uncertain edit", async () => {
  const { fetch: fetcher } = await serveHttp(({ url }) =>
    new URL(url).pathname.endsWith("/session")
      ? session()
      : new URL(url).pathname.endsWith("/csrf")
        ? json({ requestToken: "csrf" })
        : json({ code: "assignment_conflict" }, 409),
  );
  expect((await submitAssignmentEdit(request, false, fetcher)).kind).toBe("rejected");
  expect((await submitAssignmentEdit(request, true, fetcher)).kind).toBe("unknown");
});
