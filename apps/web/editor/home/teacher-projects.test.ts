import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TeacherProjectDetails, TeacherStandaloneDetails } from "./TeacherProjects";

it("shows each assigned student with a progress action and the assignment details", () => {
  const html = renderToStaticMarkup(
    createElement(TeacherProjectDetails, {
      item: {
        classId: "class",
        className: "History",
        details: {
          assignmentId: "assignment",
          title: "Silk Road",
          organizationName: "School",
          creatorName: "Ms Chew",
          creatorUserName: "mschew",
          description: "Explore trade",
          instructions: "Build a museum",
          dueAtUnixSeconds: 1900000000,
          projects: [
            {
              studentId: "alice",
              projectId: "alice-project",
              studentName: "Alice",
              approvalStatus: "approved",
              published: true,
              isPublic: true,
            },
            {
              studentId: "bob",
              projectId: "bob-project",
              studentName: "Bob",
              approvalStatus: "awaiting-approval",
              published: false,
              isPublic: false,
            },
          ],
        },
      },
      onBack: vi.fn(),
      onProgress: vi.fn(),
    }),
  );
  expect(html).toContain(
    new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(1900000000 * 1000)),
  );
  expect(html).toContain("Silk Road");
  expect(html).toContain("School");
  expect(html).toContain("@mschew");
  expect(html).toContain("Explore trade");
  expect(html).toContain("Build a museum");
  expect(html).toContain("Alice");
  expect(html).toContain("Bob");
  expect(html.match(/View Progress/g)).toHaveLength(2);
  expect(html).toContain("Approved");
  expect(html).toContain("Not Approved");
  expect(html).toContain("Public");
  expect(html).toContain("Private");
  expect(html).toContain("In Progress");
});

it("opens a standalone project in details without inventing student assignments", () => {
  const html = renderToStaticMarkup(
    createElement(TeacherStandaloneDetails, {
      project: {
        projectId: "project",
        title: "Existing museum",
        revision: 0,
        updatedAt: "2026-11-05T00:00:00Z",
        archived: false,
        permissions: { canEdit: true, canManage: true, canPublish: false },
      },
      onBack: vi.fn(),
      onOpen: vi.fn(),
    }),
  );
  expect(html).toContain("Existing museum");
  expect(html).toContain("Student assignments are not available");
  expect(html).toContain("Open project");
});
