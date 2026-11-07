import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { StudentProjectDetails } from "./StudentProjects";

it("shows the selected student's project details and opens that project", () => {
  const html = renderToStaticMarkup(
    createElement(StudentProjectDetails, {
      row: {
        project: {
          projectId: "project",
          title: "Silk Road",
          revision: 1,
          updatedAt: "2026-11-05T00:00:00Z",
          archived: false,
          permissions: { canEdit: true, canManage: false, canPublish: false },
        },
        assignment: {
          className: "History",
          details: {
            assignmentId: "assignment",
            title: "Silk Road",
            description: "Explore trade",
            instructions: "Build a museum",
            dueAtUnixSeconds: 1900000000,
            projects: [{ studentId: "alice", projectId: "project" }],
          },
        },
      },
      feedback: [],
      feedbackLoading: false,
      feedbackError: "",
      actorId: "student",
      onClose: vi.fn(),
      onOpen: vi.fn(),
    }),
  );
  expect(html).toContain("Silk Road");
  expect(html).toContain("Explore trade");
  expect(html).toContain("Build a museum");
  expect(html).toContain("Open project");
  expect(html).toContain('aria-label="Reviews"');
  expect(html).toMatch(/<button[^>]*aria-label="Close project details"[^>]*autofocus=""/);
});

it("offers Start Editing for a project with no saved revisions", () => {
  const html = renderToStaticMarkup(
    createElement(StudentProjectDetails, {
      row: {
        project: {
          projectId: "project",
          title: "New project",
          revision: 0,
          updatedAt: "2026-11-05T00:00:00Z",
          archived: false,
          permissions: { canEdit: true, canManage: false, canPublish: false },
        },
        assignment: null,
      },
      feedback: [],
      feedbackLoading: false,
      feedbackError: "",
      actorId: "student",
      onClose: vi.fn(),
      onOpen: vi.fn(),
    }),
  );
  expect(html).toContain("Start Editing");
  expect(html).not.toContain('aria-label="Reviews"');
});
