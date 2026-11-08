import { afterEach, expect, it, vi } from "vitest";
import { submitAssignmentEdit, type PendingAssignmentEdit } from "./assignment-edit";

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
