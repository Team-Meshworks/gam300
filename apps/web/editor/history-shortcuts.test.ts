import { describe, expect, it, vi } from "vitest";
import {
  handleDeleteShortcut,
  handleHistoryShortcut,
  handleSaveShortcut,
} from "./history-shortcuts";

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

describe("save shortcut", () => {
  const save = (overrides = {}, previewing = false) => {
    const actions = { save: vi.fn(), exportFile: vi.fn() };
    const event = keyEvent({ key: "s", ...overrides });
    handleSaveShortcut(event, actions, previewing);
    return { actions, event };
  };

  it.each([
    [{}, "save"],
    [{ key: "S" }, "save"],
    [{ ctrlKey: false, metaKey: true }, "save"],
    [{ key: "S", shiftKey: true }, "exportFile"],
  ] as const)("handles %j as %s", (overrides, action) => {
    const { actions, event } = save(overrides);
    expect(actions[action]).toHaveBeenCalledOnce();
    expect(actions[action === "save" ? "exportFile" : "save"]).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps Ctrl+S from the browser's Save Page As in Preview without saving", () => {
    const { actions, event } = save({}, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.exportFile).not.toHaveBeenCalled();
  });

  it("saves once while the keys are held down", () => {
    const { actions, event } = save({ repeat: true });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(actions.save).not.toHaveBeenCalled();
  });

  it.each([
    [{ isComposing: true }],
    [{ defaultPrevented: true }],
    [{ altKey: true }],
    [{ ctrlKey: false }],
    [{ key: "d" }],
  ])("ignores %j", (overrides) => {
    const { actions, event } = save(overrides);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.exportFile).not.toHaveBeenCalled();
  });
});
