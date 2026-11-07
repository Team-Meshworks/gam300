import { expect, it } from "vitest";
import { progressEditorUrl, reviewReturnUrl } from "./progress-navigation";

it("keeps the selected student's project and assignment together through editor exit", () => {
  const context = {
    classId: "11111111-1111-4111-8111-111111111111",
    assignmentId: "22222222-2222-4222-8222-222222222222",
    studentId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
  };
  const editor = new URL(progressEditorUrl(context), "https://example.test");
  expect(editor.searchParams.get("projectId")).toBe(context.projectId);
  const returned = new URL(reviewReturnUrl(editor.searchParams), "https://example.test");
  expect(returned.pathname).toBe("/home");
  expect(returned.searchParams.get("reviewProjectId")).toBe(context.projectId);
  expect(returned.searchParams.get("studentId")).toBe(context.studentId);
  expect(returned.searchParams.get("assignmentId")).toBe(context.assignmentId);
});

it("does not start review for normal editor visits or incomplete context", () => {
  expect(
    reviewReturnUrl(new URLSearchParams("projectId=44444444-4444-4444-8444-444444444444")),
  ).toBe("/home");
  expect(reviewReturnUrl(new URLSearchParams("review=1&projectId=invalid"))).toBe("/home");
});
