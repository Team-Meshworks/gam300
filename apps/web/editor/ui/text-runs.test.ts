import { describe, expect, it } from "vitest";
import { editTextRuns, markTextRuns } from "./text-runs";

describe("literal formatted text editing", () => {
  it("keeps consecutive typing within the run budget", () => {
    let runs: import("../../shared/project/project-content").TextRun[] = [];
    for (let length = 1; length <= 300; length++) {
      runs = editTextRuns(runs, "a".repeat(length), []);
    }
    expect(runs).toEqual([{ text: "a".repeat(300), marks: [] }]);
  });
  const runs = [
    { text: "First", marks: ["bold"] as const },
    { text: " last", marks: [] },
  ];
  it.each([
    [0, 1, []],
    [1, 2, ["bold"]],
  ] as const)(
    "preserves the surviving repeated character when deleting offsets %i to %i",
    (start, end, survivingMarks) => {
      const repeated = [
        { text: "a", marks: ["bold"] as const },
        { text: "a", marks: [] },
      ];
      expect(editTextRuns(repeated, "a", [], [start, end])).toEqual([
        { text: "a", marks: [...survivingMarks] },
      ]);
    },
  );
  it("keeps untouched marks when inserting literal markup", () => {
    const next = editTextRuns(runs, "First<script> last", ["italic"]);
    expect(next).toEqual([runs[0], { text: "<script>", marks: ["italic"] }, runs[1]]);
  });
  it("formats only the selected range and can toggle it off", () => {
    const next = markTextRuns(runs, 1, 7, "underline");
    expect(next.map((run) => run.text).join("")).toBe("First last");
    expect(
      next
        .filter((run) => run.marks.includes("underline"))
        .map((run) => run.text)
        .join(""),
    ).toBe("irst l");
    expect(
      markTextRuns(next, 1, 7, "underline").every((run) => !run.marks.includes("underline")),
    ).toBe(true);
  });
  it("retains Unicode and whitespace when replacing a range or deleting all text", () => {
    const next = editTextRuns([{ text: "展览 🏺\n", marks: ["bold"] }], "展览 🏺\n next", []);
    expect(next[0]).toEqual({ text: "展览 🏺\n", marks: ["bold"] });
    expect(editTextRuns(next, "", [])).toEqual([]);
  });
});
