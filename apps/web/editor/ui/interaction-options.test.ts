import { describe, expect, it } from "vitest";
import {
  newInteraction,
  targetChoices,
  withAction,
  withTrigger,
  type InteractionRule,
} from "./interaction-options";

const objects = [
  { id: "crate", name: "test-crate 1" },
  { id: "globe", name: "Snow globe" },
];

describe("interaction targets", () => {
  it("lists scene objects for object targets", () => {
    expect(targetChoices("objects", objects)).toEqual([
      { value: "crate", label: "test-crate 1" },
      { value: "globe", label: "Snow globe" },
    ]);
  });

  it("offers 5, 10 and 15 seconds for the timer", () => {
    expect(targetChoices("seconds", []).map((choice) => choice.label)).toEqual([
      "5 seconds",
      "10 seconds",
      "15 seconds",
    ]);
  });

  it("has nothing to pick for kinds that cannot be placed yet", () => {
    expect(targetChoices("hotspots", objects)).toEqual([]);
    expect(targetChoices(null, objects)).toEqual([]);
  });
});

describe("editing an interaction", () => {
  it("starts as clicking the first object", () => {
    expect(newInteraction("a", objects)).toEqual({
      id: "a",
      trigger: "click",
      triggerTarget: "crate",
      action: "show",
      actionTarget: "",
    });
  });

  it("resets the target when the trigger changes kind", () => {
    const rule: InteractionRule = newInteraction("a", objects);
    expect(withTrigger(rule, "time", objects).triggerTarget).toBe("5");
    expect(withTrigger(rule, "enter", objects).triggerTarget).toBe("");
  });

  it("clears the target when the action needs none", () => {
    const looking = withAction(newInteraction("a", objects), "lookAt", objects);
    expect(looking.actionTarget).toBe("crate");
    expect(withAction(looking, "nothing", objects).actionTarget).toBe("");
  });
});
