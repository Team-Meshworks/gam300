import { expect, it } from "vitest";
import { validateClassAssignment } from "./class-assignment";

const projects = [{ id: "project", title: "Museum", classIds: ["a"] }];
const classes = [
  { id: "a", label: "4A" },
  { id: "b", label: "4B" },
];
const students = [{ id: "student", name: "Aisyah", account: "@aisyah", classIds: ["a"] }];
const draft = { projectId: "project", classId: "a", studentIds: ["student"] };

it("preserves the chosen project, class and selected students", () => {
  expect(validateClassAssignment(draft, projects, classes, students)).toEqual({
    ok: true,
    value: draft,
  });
});
it("rejects missing or no longer eligible projects and classes", () => {
  expect(validateClassAssignment({ ...draft, projectId: "" }, projects, classes, students).ok).toBe(
    false,
  );
  expect(validateClassAssignment(draft, [], classes, students).ok).toBe(false);
  expect(validateClassAssignment({ ...draft, classId: "b" }, projects, classes, students).ok).toBe(
    false,
  );
  expect(validateClassAssignment(draft, projects, [], students).ok).toBe(false);
});
it("rejects empty, duplicate, removed or cross-class student selections", () => {
  for (const studentIds of [[], ["missing"], ["student", "student"]]) {
    expect(validateClassAssignment({ ...draft, studentIds }, projects, classes, students).ok).toBe(
      false,
    );
  }
  expect(validateClassAssignment(draft, projects, classes, []).ok).toBe(false);
  expect(
    validateClassAssignment(draft, projects, classes, [{ ...students[0]!, classIds: ["b"] }]).ok,
  ).toBe(false);
});
