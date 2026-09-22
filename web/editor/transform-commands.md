
## Edit sessions (preferred for a drag or a grouped inspector edit)

```ts
const started = store.beginTransform(objectId);
if (!started.ok) return;
const token = started.value.token;

// Each pointer update: supply a complete transform, not a delta.
store.previewTransform(token, nextTransform);
// Release:
store.commitTransformEdit(token);
// Or Escape / tool switch / component unmount:
store.cancelTransformEdit(token);
```

Use getTransformEdit() and subscribeTransformEdit() for temporary preview data. Render its after transform only for the matching object; when it becomes null, discard that override and use the current committed document. Preview notifications are separate from normal document notifications. Saving always uses getSnapshot().project, never preview state.

A new begin replaces the previous session. Tokens reject late pointer events after cancellation, project loading, deletion, addition, direct transform commits, undo or redo. Invalid previews cancel the session rather than committing the previous valid preview accidentally. Rejected unrelated edits and rejected project loads leave an existing preview alone. No-op commits finish the session without adding history. UI selection/tool changes and Escape must call cancelTransformEdit; mouse and gizmo wiring remain step 3.

## Deletion

Call store.deleteObject(objectId). A success returns the removed object in value; errors have the same path/message shape as transform errors. Undo restores the full object at its original list position, and redo removes it again. The editor's Delete selected button uses this method. This covers the current object schema; future attached content and cross-object rules will require compound deletion.
