import { expect, it } from "vitest";
import { serveHttp, serveResponses } from "../../tests/http-fixture";
import {
  assignmentChoices,
  assignmentSession,
  enrolledStudents,
  readAssignment,
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
  json({
    userId: "teacher",
    displayName: "Teacher",
    role: "Educator",
    orgId: "school",
  });
const csrf = () => json({ requestToken: "token" });

it("reads named assignment projects and rejects malformed identity labels", async () => {
  const details = {
    assignmentId: "request",
    title: "Assignment",
    description: "Description",
    instructions: "Instructions",
    dueAtUnixSeconds: 2_000_000_000,
    projects: [
      {
        studentId: "alice",
        projectId: "a",
        studentName: "Alice (alice)",
        isPublic: true,
      },
    ],
  };
  const valid = await serveResponses(json(details));
  expect(await readAssignment("class", "request", undefined, valid.fetch)).toEqual(details);
  const { fetch: fetcher } = await serveResponses(
    json({
      ...details,
      projects: [{ ...details.projects[0], isPublic: "yes" }],
    }),
  );
  await expect(readAssignment("class", "request", undefined, fetcher)).rejects.toThrow(
    "unavailable",
  );
  for (const studentName of [42, "", "  "]) {
    const { fetch: fetcher } = await serveResponses(
      json({
        ...details,
        projects: [{ ...details.projects[0], studentName }],
      }),
    );
    await expect(readAssignment("class", "request", undefined, fetcher)).rejects.toThrow(
      "unavailable",
    );
  }
});

it.each([403, 404])(
  "unlocks an initial %i denial but preserves a previously uncertain request",
  async (status) => {
    const { fetch: fetcher } = await serveHttp(({ url }) => {
      const path = url.slice(new URL(url).origin.length);
      if (path === "/api/v1/auth/session") return session();
      if (path === "/api/v1/auth/csrf") return csrf();
      return json({}, status);
    });
    expect(await submitAssignment(pending, false, fetcher)).toMatchObject({
      kind: "rejected",
    });
    expect(await submitAssignment(pending, true, fetcher)).toEqual({ kind: "unknown" });
  },
);

it("allows correction after an initial oversized request but preserves an uncertain replay", async () => {
  const { fetch: fetcher } = await serveHttp(({ url }) => {
    const path = url.slice(new URL(url).origin.length);
    if (path === "/api/v1/auth/session") return session();
    if (path === "/api/v1/auth/csrf") return csrf();
    return json({}, 413);
  });
  expect(await submitAssignment(pending, false, fetcher)).toMatchObject({
    kind: "rejected",
  });
  expect(await submitAssignment(pending, true, fetcher)).toEqual({ kind: "unknown" });
});

it("retries an uncertain request with the same identity and complete body", async () => {
  const { fetch: fetcher, requests } = await serveResponses(
    session(),
    csrf(),
    session(),
    Response.error(),
    session(),
    csrf(),
    session(),
    json({
      assignmentId: "request",
      projects: [
        { studentId: "alice", projectId: "a" },
        { studentId: "bob", projectId: "b" },
      ],
    }),
    session(),
  );
  expect(await submitAssignment(pending, false, fetcher)).toEqual({ kind: "unknown" });
  expect(await submitAssignment(pending, true, fetcher)).toMatchObject({
    kind: "confirmed",
    assignmentId: "request",
  });
  const original = await requests[3]!.text();
  expect(original).toBe(await requests[7]!.text());
  expect(JSON.parse(original)).toEqual(pending.body);
  expect(requests[3]!.headers.get("X-CSRF-TOKEN")).toBe("token");
  expect(requests[3]!.headers.get("X-Spatia-Account")).toBe("teacher");
});

it("keeps malformed success and later rejection uncertain", async () => {
  const { fetch: fetcher } = await serveResponses(
    session(),
    csrf(),
    session(),
    new Response("bad json", { status: 201 }),
    session(),
    csrf(),
    session(),
    json({}, 422),
  );
  expect(await submitAssignment(pending, false, fetcher)).toEqual({ kind: "unknown" });
  expect(await submitAssignment(pending, true, fetcher)).toEqual({ kind: "unknown" });
});

it("allows a known first rejection to be corrected and refuses another account", async () => {
  const { fetch: fetcher, requests } = await serveResponses(
    session(),
    csrf(),
    session(),
    json({}, 422),
    json({
      userId: "other",
      displayName: "Other",
      role: "Educator",
      orgId: "school",
    }),
  );
  expect(await submitAssignment(pending, false, fetcher)).toMatchObject({
    kind: "rejected",
  });
  expect(await submitAssignment(pending, false, fetcher)).toMatchObject({
    kind: "rejected",
  });
  expect(requests).toHaveLength(5);
});

it("does not submit an assignment after the account switches during CSRF acquisition", async () => {
  const { fetch: fetcher, requests } = await serveResponses(
    session(),
    csrf(),
    json({
      userId: "other",
      displayName: "Other",
      role: "Educator",
      orgId: "school",
    }),
  );
  expect((await submitAssignment(pending, false, fetcher)).kind).toBe("rejected");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it("uses authorized paginated choices and only enrolled students", async () => {
  const { fetch: fetcher } = await serveHttp(({ url }) => {
    const path = url.slice(new URL(url).origin.length);
    if (path.startsWith("/api/v1/classes/class/eligible-students"))
      return json({
        items: [
          {
            userId: "a",
            userName: "alice123",
            displayName: "Alice",
            enrolled: true,
          },
          { userId: "b", userName: "Bob", enrolled: false },
        ],
        nextCursor: null,
      });
    if (path.startsWith("/api/v1/classes"))
      return json({
        items: [{ id: "class", name: "Class" }],
        nextCursor: null,
      });
    if (path.includes("cursor=next"))
      return json({
        items: [
          {
            projectId: "two",
            title: "Two",
            revision: 1,
            permissions: { canManage: true },
          },
        ],
        nextCursor: null,
      });
    return json({
      items: [
        {
          projectId: "one",
          title: "One",
          revision: 0,
          permissions: { canManage: false },
        },
      ],
      nextCursor: "next",
    });
  });
  expect(await assignmentChoices(undefined, fetcher)).toEqual({
    classes: [{ id: "class", label: "Class" }],
    projects: [{ projectId: "two", title: "Two", revision: 1 }],
  });
  expect(await enrolledStudents("class", undefined, fetcher)).toEqual([
    { id: "a", name: "Alice", account: "alice123", classIds: ["class"] },
  ]);
});

it("uses the authoritative login name independently from the display name", async () => {
  const { fetch: fetcher } = await serveResponses(
    json({
      userId: "teacher",
      displayName: "Ms Tan",
      userName: "teacher.tan",
      role: "Educator",
      orgId: "school",
    }),
  );
  expect((await assignmentSession(undefined, fetcher)).userName).toBe("teacher.tan");
  const withoutLoginName = await serveResponses(
    json({
      userId: "teacher",
      displayName: "Ms Tan",
      role: "Educator",
      orgId: "school",
    }),
  );
  expect((await assignmentSession(undefined, withoutLoginName.fetch)).userName).toBeUndefined();
});
