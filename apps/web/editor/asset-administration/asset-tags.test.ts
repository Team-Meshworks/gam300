import { describe, expect, it } from "vitest";
import { normalizeTag, tagKey } from "./asset-tags";

describe("tag validation shared with the server", () => {
  it("accepts supplementary CJK letters the server also accepts", () => {
    // U+20000 is CJK Extension B, sent as a surrogate pair
    expect(normalizeTag("\u{20000}  Kampong", 40)).toBe("\u{20000} Kampong");
    expect(tagKey("\u{20000} Kampong")).toBe("\u{20000}kampong");
  });
});
