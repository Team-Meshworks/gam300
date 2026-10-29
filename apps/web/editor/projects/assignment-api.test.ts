import { afterEach, expect, it, vi } from "vitest";
import {
  assignmentChoices,
  enrolledStudents,
  submitAssignment,
  type PendingAssignment,
} from "./assignment-api";

const pending: PendingAssignment = {
  actorId: "teacher",
  classId: "class",
  body: {
    requestId: "request",
    sourceProjectId: "source",
    sourceRevision: 3,
    dueAtUnixSeconds: 2_000_000_000,
    title: "Title",
    description: "Description",
    instructions: "Instructions",
    studentIds: ["alice", "bob"],
  },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const session = () =>
  json({ userId: "teacher", displayName: "Teacher", role: "Educator", orgId: "school" });
const csrf = () => json({ requestToken: "token" });

afterEach(() => vi.unstubAllGlobals());

it("retries an uncertain request with the same identity and complete body", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(csrf())
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(csrf())
    .mockResolvedValueOnce(
      json({
        assignmentId: "request",
        projects: [
          { studentId: "alice", projectId: "a" },
          { studentId: "bob", projectId: "b" },
        ],
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  expect(await submitAssignment(pending, false)).toEqual({ kind: "unknown" });
  expect(await submitAssignment(pending, true)).toMatchObject({
    kind: "confirmed",
    assignmentId: "request",
  });
  expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(fetchMock.mock.calls[5]?.[1]?.body);
  expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual(pending.body);
  expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ "X-CSRF-TOKEN": "token" });
});

it("keeps malformed success and later rejection uncertain", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(csrf())
    .mockResolvedValueOnce(new Response("bad json", { status: 201 }))
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(csrf())
    .mockResolvedValueOnce(json({}, 422));
  vi.stubGlobal("fetch", fetchMock);
  expect(await submitAssignment(pending, false)).toEqual({ kind: "unknown" });
  expect(await submitAssignment(pending, true)).toEqual({ kind: "unknown" });
});

it("allows a known first rejection to be corrected and refuses another account", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(session())
    .mockResolvedValueOnce(csrf())
    .mockResolvedValueOnce(json({}, 422))
    .mockResolvedValueOnce(
      json({ userId: "other", displayName: "Other", role: "Educator", orgId: "school" }),
    );
  vi.stubGlobal("fetch", fetchMock);
  expect(await submitAssignment(pending, false)).toMatchObject({ kind: "rejected" });
  expect(await submitAssignment(pending, false)).toMatchObject({ kind: "rejected" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("uses authorized paginated choices and only enrolled students", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path.startsWith("/api/classes/class/eligible-students"))
        return json({
          items: [
            { userId: "a", userName: "Alice", enrolled: true },
            { userId: "b", userName: "Bob", enrolled: false },
          ],
          nextCursor: null,
        });
      if (path.startsWith("/api/classes"))
        return json({ items: [{ id: "class", name: "Class" }], nextCursor: null });
      if (path.includes("cursor=next"))
        return json({
          items: [
            { projectId: "two", title: "Two", revision: 1, permissions: { canManage: true } },
          ],
          nextCursor: null,
        });
      return json({
        items: [{ projectId: "one", title: "One", revision: 0, permissions: { canManage: false } }],
        nextCursor: "next",
      });
    }),
  );
  expect(await assignmentChoices()).toEqual({
    classes: [{ id: "class", label: "Class" }],
    projects: [{ projectId: "two", title: "Two", revision: 1 }],
  });
  expect(await enrolledStudents("class")).toEqual([
    { id: "a", name: "Alice", account: "Alice", classIds: ["class"] },
  ]);
});
