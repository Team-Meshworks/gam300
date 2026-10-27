import { describe, expect, it, vi } from "vitest";
import { createCommandHistory } from "./command-history";
import { handleDeleteShortcut, handleHistoryShortcut } from "./history-shortcuts";

function keyEvent(overrides = {}) {
  return {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("history shortcuts", () => {
  it("uses the existing history and drops redo after a new edit", () => {
    const history = createCommandHistory<number>();
    const increment = { label: "Edit", apply: (n: number) => n + 1, revert: (n: number) => n - 1 };
    let state = history.execute(0, increment);
    const actions = {
      undo: () => {
        state = history.undo(state);
      },
      redo: () => {
        state = history.redo(state);
      },
    };
    handleHistoryShortcut(keyEvent(), actions, false);
    expect(state).toBe(0);
    handleHistoryShortcut(keyEvent({ key: "y" }), actions, false);
    expect(state).toBe(1);
    handleHistoryShortcut(keyEvent(), actions, false);
    state = history.execute(state, increment);
    handleHistoryShortcut(keyEvent({ key: "Z", shiftKey: true }), actions, false);
    expect(state).toBe(1);
    expect(history.canRedo).toBe(false);
  });

  it.each([
    [{}, "undo"],
    [{ key: "y" }, "redo"],
    [{ key: "Z", shiftKey: true }, "redo"],
    [{ ctrlKey: false, metaKey: true }, "undo"],
    [{ ctrlKey: false, metaKey: true, shiftKey: true }, "redo"],
  ] as const)("handles %j as %s", (overrides, action) => {
    const actions = { undo: vi.fn(), redo: vi.fn() };
    const event = keyEvent(overrides);
    handleHistoryShortcut(event, actions, false);
    expect(actions[action]).toHaveBeenCalledOnce();
    expect(actions[action === "undo" ? "redo" : "undo"]).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, true],
    [{ isComposing: true }, false],
    [{ defaultPrevented: true }, false],
    [{ altKey: true }, false],
    [{ ctrlKey: false }, false],
    [{ key: "c" }, false],
    [{ key: "v" }, false],
  ] as const)("leaves other keyboard handling alone: %j, typing=%s", (overrides, typing) => {
    const actions = { undo: vi.fn(), redo: vi.fn() };
    const event = keyEvent(overrides);
    handleHistoryShortcut(event, actions, typing);
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.redo).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("suppresses held-key repeats without running another command", () => {
    const actions = { undo: vi.fn(), redo: vi.fn() };
    const event = keyEvent({ repeat: true });
    handleHistoryShortcut(event, actions, false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.redo).not.toHaveBeenCalled();
  });
});

describe("delete shortcut", () => {
  it("deletes with Delete or Backspace", () => {
    const remove = vi.fn();
    handleDeleteShortcut(keyEvent({ key: "Delete", ctrlKey: false }), remove, false);
    handleDeleteShortcut(keyEvent({ key: "Backspace", ctrlKey: false }), remove, false);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("leaves typing, modified keys and held keys alone", () => {
    const remove = vi.fn();
    handleDeleteShortcut(keyEvent({ key: "Backspace", ctrlKey: false }), remove, true);
    handleDeleteShortcut(keyEvent({ key: "Delete" }), remove, false);
    handleDeleteShortcut(keyEvent({ key: "Delete", ctrlKey: false, repeat: true }), remove, false);
    expect(remove).not.toHaveBeenCalled();
  });
});
