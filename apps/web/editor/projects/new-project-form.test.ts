import { describe, expect, it } from "vitest";
import { validateNewProject, type NewProjectDraft } from "./new-project-form";

const classes = [
  { id: "class-a", label: "4A" },
  { id: "class-b", label: "4B" },
];
const students = [
  { id: "a", name: "Aisyah", account: "@aisyah", classIds: ["class-a"] },
  { id: "b", name: "Ben", account: "@ben", classIds: ["class-b"] },
];
const draft: NewProjectDraft = {
  title: "My museum",
  description: "History",
  instructions: "Build exhibits",
  dueDate: "2028-02-29",
  classId: "class-a",
  imageType: "Cover image",
  studentIds: ["a"],
};

describe("New Project frontend validation", () => {
  it("treats Gallery as a picker rather than an image type", () => {
    expect(validateNewProject({ ...draft, imageType: "Gallery" }, classes, students)).toMatchObject(
      { ok: false, field: "imageType" },
    );
  });
  it("preserves the selected local cover file for the host", () => {
    const coverImage = new File(["local image"], "cover.png", { type: "image/png" });
    const result = validateNewProject({ ...draft, coverImage }, classes, students);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.coverImage).toBe(coverImage);
  });
  it("keeps every entered field and a calendar date without inventing a timezone cutoff", () => {
    expect(validateNewProject(draft, classes, students)).toEqual({ ok: true, value: draft });
  });
  it.each(["title", "description", "instructions"] as const)("rejects blank %s", (field) => {
    expect(validateNewProject({ ...draft, [field]: " \n " }, classes, students)).toMatchObject({
      ok: false,
      field,
    });
  });
  it.each(["2027-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "not-a-date"])(
    "rejects impossible date %s",
    (dueDate) => {
      expect(validateNewProject({ ...draft, dueDate }, classes, students)).toMatchObject({
        ok: false,
        field: "dueDate",
      });
    },
  );
  it("refuses missing or stale class and student choices", () => {
    expect(validateNewProject({ ...draft, classId: "" }, classes, students)).toMatchObject({
      ok: false,
      field: "classId",
    });
    expect(validateNewProject(draft, [], students)).toMatchObject({ ok: false, field: "classId" });
    for (const studentIds of [[], ["missing"], ["b"], ["a", "a"]]) {
      expect(validateNewProject({ ...draft, studentIds }, classes, students)).toMatchObject({
        ok: false,
        field: "studentIds",
      });
    }
    expect(validateNewProject(draft, classes, [])).toMatchObject({
      ok: false,
      field: "studentIds",
    });
  });
});
