import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.unstubAllGlobals());

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
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(session())
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(json({ requestToken: "csrf" }))
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(json({ assignmentId: "assignment", revision: 3 }))
    .mockResolvedValueOnce(session());
  vi.stubGlobal("fetch", fetcher);
  expect(await submitAssignmentEdit(request, false)).toEqual({ kind: "unknown" });
  expect(await submitAssignmentEdit(request, true)).toEqual({ kind: "confirmed" });
  expect(fetcher.mock.calls[3]?.[1]?.body).toBe(fetcher.mock.calls[7]?.[1]?.body);
  expect(JSON.parse(fetcher.mock.calls[3]?.[1]?.body)).toEqual(request.body);
});

it("only unlocks a known first conflict; later denials cannot resolve an uncertain edit", async () => {
  const fetcher = vi.fn(async (path: string) =>
    path.endsWith("/session")
      ? session()
      : path.endsWith("/csrf")
        ? json({ requestToken: "csrf" })
        : json({ code: "assignment_conflict" }, 409),
  );
  vi.stubGlobal("fetch", fetcher);
  expect((await submitAssignmentEdit(request, false)).kind).toBe("rejected");
  expect((await submitAssignmentEdit(request, true)).kind).toBe("unknown");
});
