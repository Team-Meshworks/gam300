import { describe, expect, it } from "vitest";
import { containDisplay, wrapDisplayText } from "./display-layout";

describe("display layout", () => {
  it("letterboxes landscape and portrait media without stretching", () => {
    expect(containDisplay(2, 1, 100, 100)).toEqual({ width: 1, height: 1 });
    expect(containDisplay(1, 2, 100, 50)).toEqual({ width: 1, height: 0.5 });
  });
  it("rejects invalid source dimensions", () => {
    expect(containDisplay(1, 1, 0, 10)).toEqual({ width: 0, height: 0 });
    expect(containDisplay(1, 1, NaN, 10)).toEqual({ width: 0, height: 0 });
  });
  it("wraps literal strings and retains paragraph breaks", () => {
    expect(wrapDisplayText("abcd\ne", 3, (text) => text.length)).toEqual(["abc", "d", "e"]);
    expect(wrapDisplayText("<script>", 100, (text) => text.length)).toEqual(["<script>"]);
  });
  it("bounds text rendering work", () => {
    expect(wrapDisplayText("a".repeat(65536), 10, (text) => text.length, 3)).toHaveLength(3);
  });
});
