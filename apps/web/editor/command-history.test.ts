import { describe, expect, it } from "vitest";
import { createCommandHistory, type EditCommand } from "./command-history";

// Numbers keep these tests focused on history; scene objects are covered by the store tests.
const increment: EditCommand<number> = {
  label: "Increment",
  apply: (value) => value + 1,
  revert: (value) => value - 1,
};
describe("command history", () => {
  it("reverses different commands in order and branches only on committed edits", () => {
    const history = createCommandHistory<number>();
    const double: EditCommand<number> = {
      label: "Double",
      apply: (x) => x * 2,
      revert: (x) => x / 2,
    };
    let state = history.execute(2, increment);
    state = history.execute(state, double);
    expect(state).toBe(6);
    state = history.undo(state);
    expect(state).toBe(3);
    expect(history.redo(state)).toBe(6);
    state = history.undo(6);
    expect(history.execute(state, { label: "No change", apply: (x) => x, revert: (x) => x })).toBe(
      3,
    );
    expect(history.canRedo).toBe(true);
    expect(history.execute(state, increment)).toBe(4);
    expect(history.canRedo).toBe(false);
  });
  it("preserves history on failed apply, undo and redo", () => {
    const history = createCommandHistory<number>();
    // Make the same command fail and then recover, to check that it is not lost.
    let failApply = false;
    let failRevert = false;
    const command: EditCommand<number> = {
      label: "Fallible",
      apply: (x) => {
        if (failApply) throw new Error("apply failed");
        return x + 1;
      },
      revert: (x) => {
        if (failRevert) throw new Error("revert failed");
        return x - 1;
      },
    };
    expect(history.execute(0, command)).toBe(1);
    failRevert = true;
    expect(() => history.undo(1)).toThrow("revert failed");
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    failRevert = false;
    expect(history.undo(1)).toBe(0);
    failApply = true;
    expect(() => history.redo(0)).toThrow("apply failed");
    expect(() => history.execute(0, command)).toThrow("apply failed");
    expect(history.canRedo).toBe(true);
    expect(history.canUndo).toBe(false);
    failApply = false;
    expect(history.redo(0)).toBe(1);
  });
  it("bounds history, clears both stacks and treats empty history as no change", () => {
    // A two-step limit makes it easy to check what happens to the oldest edit.
    const history = createCommandHistory<number>(2);
    let state = 0;
    for (let i = 0; i < 3; i++) state = history.execute(state, increment);
    state = history.undo(state);
    state = history.undo(state);
    expect(state).toBe(1);
    expect(history.undo(state)).toBe(1);
    expect(history.canUndo).toBe(false);
    history.clear();
    expect(history.canRedo).toBe(false);
    expect(history.redo(state)).toBe(state);
    expect(() => createCommandHistory(0)).toThrow();
  });
});
