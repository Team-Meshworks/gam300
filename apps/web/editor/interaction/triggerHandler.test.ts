import { describe, expect, it } from "vitest";
import { DEFAULT_ELAPSED_SECONDS, triggerMatches, triggerSeconds } from "./triggerHandler";

describe("trigger handler", () => {
  it("matches a click only on its target object", () => {
    const trigger = { type: "visitor-clicks-object", targetObjectId: "crate" } as const;

    expect(triggerMatches(trigger, { type: "visitor-clicks-object", objectId: "crate" })).toBe(
      true,
    );
    expect(triggerMatches(trigger, { type: "visitor-clicks-object", objectId: "other" })).toBe(
      false,
    );
  });

  it("matches scene starts and elapsed time events", () => {
    expect(triggerMatches({ type: "scene-starts" }, { type: "scene-starts" })).toBe(true);
    expect(triggerMatches({ type: "time-elapsed" }, { type: "time-elapsed" })).toBe(true);
  });

  it("uses two seconds for elapsed triggers unless a time is set", () => {
    expect(triggerSeconds({ type: "time-elapsed" })).toBe(DEFAULT_ELAPSED_SECONDS);
    expect(triggerSeconds({ type: "time-elapsed", seconds: 5 })).toBe(5);
    expect(triggerSeconds({ type: "scene-starts" })).toBe(0);
  });
});
