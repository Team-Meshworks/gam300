import { expect, it } from "vitest";
import { progressEditorUrl, reviewReturnUrl, parseProgressContext } from "./progress-navigation";

it("keeps the selected student's project and assignment together through editor exit", () => {
  const context = {
    classId: "11111111-1111-4111-8111-111111111111",
    assignmentId: "22222222-2222-4222-8222-222222222222",
    studentId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
  };
  const editor = new URL(progressEditorUrl(context), "https://example.test");
  expect(parseProgressContext(editor.searchParams, context.projectId)).toEqual(context);
  expect(
    parseProgressContext(editor.searchParams, "55555555-5555-4555-8555-555555555555"),
  ).toBeNull();
  expect(editor.searchParams.get("projectId")).toBe(context.projectId);
  const returned = new URL(reviewReturnUrl(editor.searchParams), "https://example.test");
  expect(returned.pathname).toBe("/home");
  expect(reviewReturnUrl(editor.searchParams, "Administrator")).toBe(
    returned.pathname + returned.search,
  );
  expect(returned.searchParams.get("reviewProjectId")).toBe(context.projectId);
  expect(returned.searchParams.get("studentId")).toBe(context.studentId);
  expect(returned.searchParams.get("assignmentId")).toBe(context.assignmentId);
  const inspected = new URL(
    reviewReturnUrl(editor.searchParams, "Educator"),
    "https://example.test",
  );
  expect(inspected.searchParams.get("assignmentId")).toBe(context.assignmentId);
  expect(inspected.searchParams.has("reviewProjectId")).toBe(false);
  expect(inspected.searchParams.has("studentId")).toBe(false);
});

it("does not start review for normal editor visits or incomplete context", () => {
  expect(
    reviewReturnUrl(new URLSearchParams("projectId=44444444-4444-4444-8444-444444444444")),
  ).toBe("/home");
  expect(reviewReturnUrl(new URLSearchParams("review=1&projectId=invalid"))).toBe("/home");
  expect(
    reviewReturnUrl(
      new URLSearchParams("projectId=44444444-4444-4444-8444-444444444444"),
      "Administrator",
    ),
  ).toBe("/admin/dashboard");
  expect(reviewReturnUrl(new URLSearchParams(), "Creator")).toBe("/home");
  expect(reviewReturnUrl(new URLSearchParams(), "Educator")).toBe("/home");
  expect(
    parseProgressContext(new URLSearchParams("review=1&projectId=invalid"), "invalid"),
  ).toBeNull();
});
