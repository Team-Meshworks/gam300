type ShortcutEvent = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "altKey"
  | "repeat"
  | "isComposing"
  | "defaultPrevented"
  | "preventDefault"
>;

type HistoryActions = { undo(): void; redo(): void };

export function handleObjectShortcut(
  event: ShortcutEvent,
  actions: { copy(): void; paste(): void; duplicate(): void },
  editingText: boolean,
) {
  if (editingText || event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey)
    return;
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key !== "c" && key !== "v" && key !== "d") return;
  // Ctrl+D belongs to duplication here, rather than the browser's bookmark action.
  event.preventDefault();
  if (event.repeat) return;
  if (key === "c") actions.copy();
  else if (key === "v") actions.paste();
  else actions.duplicate();
}

export function handleHistoryShortcut(
  event: ShortcutEvent,
  history: HistoryActions,
  editingText: boolean,
) {
  // Text fields own their undo history, including when a child of a rich-text field has focus.
  if (editingText || event.defaultPrevented || event.isComposing || event.altKey) return;
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  const undo = key === "z" && !event.shiftKey;
  const redo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
  if (!undo && !redo) return;

  // Even with empty history, keep this shortcut inside the editor. Holding it down
  // shouldn't race through several edits before the user can see what changed.
  event.preventDefault();
  if (event.repeat) return;
  if (undo) history.undo();
  else history.redo();
}

export function isTextEditingTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="textbox"]') !== null)
  );
}
