// Each command knows how to make one edit and how to put things back.
// Leave the old state untouched. Return the same state if the edit is rejected
// or changes nothing, so it won't use an undo step.
// This history only lasts for the current session; it stays out of saved JSON.
export type EditCommand<State> = Readonly<{
  label: string;
  apply: (state: State) => State;
  revert: (state: State) => State;
}>;

export function createCommandHistory<State>(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("History limit must be a positive integer");
  const undoStack: EditCommand<State>[] = [];
  const redoStack: EditCommand<State>[] = [];
  return {
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    execute(state: State, command: EditCommand<State>): State {
      // Try the edit before touching history. If it fails, the user can still
      // undo or redo exactly what they could before.
      const next = command.apply(state);
      if (Object.is(next, state)) return state;
      undoStack.push(Object.freeze({ ...command }));
      // Forget the oldest undo step when we reach the limit; keep the edit itself.
      if (undoStack.length > limit) undoStack.shift();
      // A new edit after undo starts a different path, so the old redo path ends here.
      redoStack.length = 0;
      return next;
    },
    undo(state: State): State {
      const command = undoStack.at(-1);
      if (!command) return state;
      // Keep the command on the undo stack until reverting it succeeds.
      const next = command.revert(state);
      if (Object.is(next, state)) return state;
      undoStack.pop();
      redoStack.push(command);
      return next;
    },
    // Reuse the recorded command so redo keeps the same object IDs and edit data.
    redo(state: State): State {
      const command = redoStack.at(-1);
      if (!command) return state;
      const next = command.apply(state);
      if (Object.is(next, state)) return state;
      redoStack.pop();
      undoStack.push(command);
      return next;
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
