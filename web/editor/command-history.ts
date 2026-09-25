// Each command knows how to make one edit and how to put things back.
// Leave the old state untouched. Return the same state if the edit is rejected
// or changes nothing, so it won't use an undo step.
// Recovery can save the states behind commands; executable functions stay out of JSON.
export type EditCommand<State> = Readonly<{
  label: string;
  apply: (state: State) => State;
  revert: (state: State) => State;
}>;

export function createCommandHistory<State>(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("History limit must be a positive integer");
  type Entry = { command: EditCommand<State>; before: State; after: State };
  const undoStack: Entry[] = [];
  const redoStack: Entry[] = [];
  return {
    getStates() {
      // Nearest edit first, matching the order in which Undo and Redo will visit them.
      return {
        past: undoStack.toReversed().map((entry) => entry.before),
        future: redoStack.toReversed().map((entry) => entry.after),
      };
    },
    restoreStates(current: State, past: readonly State[], future: readonly State[]) {
      if (past.length + future.length > limit)
        throw new Error("Recovered history exceeds its limit");
      function entry(before: State, after: State): Entry {
        return {
          before,
          after,
          command: {
            label: "Recovered edit",
            apply: () => after,
            revert: () => before,
          },
        };
      }
      undoStack.length = 0;
      redoStack.length = 0;
      undoStack.push(
        ...past.map((before, i) => entry(before, i === 0 ? current : past[i - 1]!)).reverse(),
      );
      redoStack.push(
        ...future.map((after, i) => entry(i === 0 ? current : future[i - 1]!, after)).reverse(),
      );
    },
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
      undoStack.push({ command: Object.freeze({ ...command }), before: state, after: next });
      // Forget the oldest undo step when we reach the limit; keep the edit itself.
      if (undoStack.length > limit) undoStack.shift();
      // A new edit after undo starts a different path, so the old redo path ends here.
      redoStack.length = 0;
      return next;
    },
    undo(state: State): State {
      const entry = undoStack.at(-1);
      if (!entry) return state;
      // Keep the command on the undo stack until reverting it succeeds.
      const next = entry.command.revert(state);
      if (Object.is(next, state)) return state;
      undoStack.pop();
      redoStack.push(entry);
      return next;
    },
    // Reuse the recorded command so redo keeps the same object IDs and edit data.
    redo(state: State): State {
      const entry = redoStack.at(-1);
      if (!entry) return state;
      const next = entry.command.apply(state);
      if (Object.is(next, state)) return state;
      redoStack.pop();
      undoStack.push(entry);
      return next;
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
