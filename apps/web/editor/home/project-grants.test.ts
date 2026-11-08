import { expect, it, vi } from "vitest";
import type { ManagedAccount } from "../directory/directory-client";
import {
  parseProjectGrants,
  projectGrantDraft,
  projectGrantReplacement,
  readProjectGrantEditor,
} from "./project-grants";

const projectId = "00000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const teacherId = "00000000-0000-4000-8000-000000000004";
const studentId = "00000000-0000-4000-8000-000000000005";
const accounts: ManagedAccount[] = [
  {
    userId: teacherId,
    userName: "teacher",
    displayName: "Teacher",
    orgId,
    role: "Educator",
    isActive: true,
    mustChangePassword: false,
  },
  {
    userId: studentId,
    userName: "student",
    displayName: "Student",
    orgId,
    role: "Creator",
    isActive: true,
    mustChangePassword: false,
  },
];
const snapshot = {
  projectId,
  organizationId: orgId,
  revision: 7,
  archived: false,
  assignments: [
    { userId: teacherId, canEdit: true, canManage: true, canPublish: true },
    { userId: studentId, canEdit: true, canManage: false, canPublish: false },
  ],
};

it("round-trips the complete current access set at its read revision", () => {
  const current = parseProjectGrants(snapshot, projectId);
  const draft = projectGrantDraft(current, accounts);
  expect(draft).toEqual({
    managedByUserIds: [teacherId],
    assignedCreatorIds: [studentId],
    canPublishUserIds: [],
  });
  expect(
    projectGrantReplacement(current, accounts, { ...draft, canPublishUserIds: [studentId] }),
  ).toEqual({
    expectedRevision: 7,
    managedByUserIds: [teacherId],
    assignedCreatorIds: [studentId],
    canPublishUserIds: [studentId],
  });
  expect(snapshot.assignments[1]?.canPublish).toBe(false);
});

it("refuses partial, duplicate, mismatched or invalid current grants", () => {
  for (const value of [
    { ...snapshot, projectId: orgId },
    { ...snapshot, revision: -1 },
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, assignments: [...snapshot.assignments, snapshot.assignments[0]] },
    { ...snapshot, assignments: [{ userId: teacherId, canEdit: true }] },
  ])
    expect(() => parseProjectGrants(value, projectId)).toThrow();
});

it("never drops or upgrades grants that the replacement API cannot round-trip", () => {
  for (const current of [
    { ...snapshot, archived: true },
    {
      ...snapshot,
      assignments: [{ userId: teacherId, canEdit: true, canManage: true, canPublish: false }],
    },
    {
      ...snapshot,
      assignments: [{ userId: studentId, canEdit: false, canManage: false, canPublish: false }],
    },
    {
      ...snapshot,
      assignments: [{ userId: studentId, canEdit: true, canManage: true, canPublish: true }],
    },
    {
      ...snapshot,
      assignments: [{ userId: actorId, canEdit: true, canManage: false, canPublish: false }],
    },
  ])
    expect(() => projectGrantDraft(current, accounts)).toThrow();
  expect(() =>
    projectGrantDraft(
      snapshot,
      accounts.map((row) => ({ ...row, isActive: false })),
    ),
  ).toThrow();
  expect(() =>
    projectGrantDraft(
      snapshot,
      accounts.map((row) => ({ ...row, orgId: actorId })),
    ),
  ).toThrow();
});

it("rejects invalid replacements instead of changing permission meaning", () => {
  const draft = projectGrantDraft(snapshot, accounts);
  for (const replacement of [
    { ...draft, managedByUserIds: [studentId] },
    { ...draft, assignedCreatorIds: [teacherId] },
    { ...draft, assignedCreatorIds: [studentId, studentId] },
    { ...draft, assignedCreatorIds: [], canPublishUserIds: [studentId] },
    { ...draft, canPublishUserIds: [teacherId] },
  ])
    expect(() => projectGrantReplacement(snapshot, accounts, replacement)).toThrow();
  expect(
    projectGrantReplacement(snapshot, accounts, {
      managedByUserIds: [],
      assignedCreatorIds: [],
      canPublishUserIds: [],
    }),
  ).toEqual({
    expectedRevision: 7,
    managedByUserIds: [],
    assignedCreatorIds: [],
    canPublishUserIds: [],
  });
});

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

it("loads current grants and complete authorized choices under the captured administrator", async () => {
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("X-Spatia-Account")).toBe(actorId);
    const path = String(input);
    if (path === `/api/v1/projects/${projectId}/assignments`) return json(snapshot);
    if (path.startsWith("/api/v1/admin/organizations"))
      return json({
        items: [
          {
            id: orgId,
            name: "School",
            isActive: true,
            projectCount: 0,
            facilitatorCount: 0,
            creatorCount: 0,
          },
        ],
        nextCursor: null,
      });
    if (path.includes("cursor=")) return json({ items: [accounts[1]], nextCursor: null });
    if (path.startsWith("/api/v1/admin/users"))
      return json({ items: [accounts[0]], nextCursor: teacherId });
    if (path === "/api/v1/auth/session")
      return json({
        userId: actorId,
        displayName: "Admin",
        role: "Administrator",
        orgId: null,
        mustChangePassword: false,
      });
    throw new Error(`Unexpected request ${path}`);
  });
  expect(
    await readProjectGrantEditor(projectId, actorId, new AbortController().signal, request),
  ).toEqual({ snapshot, accounts });
  expect(request.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
});

it("rejects a changed account or inactive organisation after loading choices", async () => {
  for (const changedAccount of [true, false]) {
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === `/api/v1/projects/${projectId}/assignments`) return json(snapshot);
      if (path.startsWith("/api/v1/admin/organizations"))
        return json({
          items: [
            {
              id: orgId,
              name: "School",
              isActive: changedAccount,
              projectCount: 0,
              facilitatorCount: 0,
              creatorCount: 0,
            },
          ],
          nextCursor: null,
        });
      if (path.startsWith("/api/v1/admin/users"))
        return json({ items: accounts, nextCursor: null });
      return json({
        userId: projectId,
        displayName: "Other",
        role: "Administrator",
        orgId: null,
        mustChangePassword: false,
      });
    });
    await expect(
      readProjectGrantEditor(projectId, actorId, new AbortController().signal, request),
    ).rejects.toThrow();
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  }
});

it("refuses ambiguous duplicate account choices", async () => {
  const request = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === `/api/v1/projects/${projectId}/assignments`) return json(snapshot);
    if (path.startsWith("/api/v1/admin/organizations"))
      return json({
        items: [
          {
            id: orgId,
            name: "School",
            isActive: true,
            projectCount: 0,
            facilitatorCount: 0,
            creatorCount: 0,
          },
        ],
        nextCursor: null,
      });
    if (path.startsWith("/api/v1/admin/users"))
      return json({ items: [...accounts, accounts[0]], nextCursor: null });
    return json({
      userId: actorId,
      displayName: "Admin",
      role: "Administrator",
      orgId: null,
      mustChangePassword: false,
    });
  });
  await expect(
    readProjectGrantEditor(projectId, actorId, new AbortController().signal, request),
  ).rejects.toThrow();
});
