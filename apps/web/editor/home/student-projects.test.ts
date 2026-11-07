import { describe, expect, it } from "vitest";
import { studentProjectRows } from "./student-projects";

const project = (projectId: string, title: string, revision = 0) => ({
  projectId,
  title,
  revision,
  updatedAt: "2026-11-05T00:00:00Z",
  archived: false,
  permissions: { canEdit: true, canManage: false, canPublish: false },
});
const assignment = {
  className: "History",
  details: {
    assignmentId: "assignment",
    title: "Silk Road",
    description: "Explore trade",
    instructions: "Build a museum",
    dueAtUnixSeconds: 1900000000,
    projects: [
      { studentId: "alice", projectId: "alice-project" },
      { studentId: "bob", projectId: "bob-project" },
    ],
  },
};

describe("student project rows", () => {
  it("joins the signed-in student's own assignment to its visible project and keeps standalone projects", () => {
    const rows = studentProjectRows(
      "alice",
      [project("alice-project", "Silk Road"), project("other", "My project")],
      [assignment],
    );
    expect(rows.map((row) => row.project.projectId)).toEqual(["alice-project", "other"]);
    expect(rows[0]?.assignment?.details.instructions).toBe("Build a museum");
    expect(rows[1]?.assignment).toBeNull();
  });
  it("never attaches another student's assignment to a visible project", () => {
    const rows = studentProjectRows("alice", [project("bob-project", "Shared")], [assignment]);
    expect(rows[0]?.assignment).toBeNull();
  });
  it("does not choose an arbitrary assignment if mappings conflict", () => {
    const rows = studentProjectRows(
      "alice",
      [project("alice-project", "Silk Road")],
      [assignment, { ...assignment, className: "Other" }],
    );
    expect(rows[0]?.assignment).toBeNull();
  });
});
