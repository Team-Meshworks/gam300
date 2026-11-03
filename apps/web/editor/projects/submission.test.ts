import { describe, expect, it } from "vitest";
import { canAct, confirmsAction, type Submission } from "./submission";
const base: Submission = {
  id: "s1",
  revision: 1,
  title: "Project",
  student: "Aisyah",
  className: "4A",
  state: "submitted",
};
describe("submission outcome boundaries", () => {
  it("allows only actions for the current state and audience", () => {
    expect(canAct(base, "approve", "teacher")).toBe(true);
    expect(canAct(base, "approve", "student")).toBe(false);
    expect(canAct({ ...base, state: "editing" }, "approve", "teacher")).toBe(false);
    expect(canAct({ ...base, state: "completed" }, "submit", "student")).toBe(true);
  });
  it("requires the confirmed identity, content revision and expected state", () => {
    const draft = { id: "s1", revision: 1, action: "approve" as const, feedback: "" };
    expect(confirmsAction(draft, { ...base, state: "approved" })).toBe(true);
    expect(confirmsAction(draft, base)).toBe(false);
    expect(confirmsAction(draft, { ...base, id: "s2", state: "approved" })).toBe(false);
    expect(confirmsAction(draft, { ...base, revision: 2, state: "approved" })).toBe(false);
  });
});
