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

## Undo after refresh

Browser autosave captures `getSnapshot().project` and `getRecoveryHistory()` together before awaiting storage. IndexedDB writes both in one transaction with the existing revision checks. Recovery passes the checked history as the third argument to `loadProject`; ordinary file imports omit it and start with empty history. Exported JSON still contains only the project.

Recovery version 1 stores immutable object-list states in undo/redo order, preserving IDs, transforms and list positions. It keeps at most 100 edits, with a 20 MiB serialized-history budget that drops the farthest states first. Commands restored from those states use the same command history as new edits. This matches the current single-scene object commands; commands that change scene metadata or future content/rules must extend this format before using it.

Each restored state goes through the project validator. Project/scene IDs and the current object list must match the saved scene. Missing history in older backups is supported. Invalid history is skipped with a warning while the valid scene is recovered. A mismatched scene/history pair is rejected before saving.

Only completed edits are saved. The existing autosave waits two seconds after editing; wait for **Saved in browser** (and no Saving indicator) before refreshing. Refresh cannot recover history from backups created before this feature existed. Browser storage belongs to this browser profile and site origin.

Checks: `npm run test:unit` and `node tests/history-recovery.smoke.mjs <dev-server-url>`. The browser script uses a fresh isolated context and supports the same `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_CHANNEL` overrides as the other smoke tests.
