# Connecting gizmos to transform undo

Call `store.commitTransform({ objectId, before, after })` once when a drag or inspector edit finishes. Use the placed object's ID, not the asset ID. Transforms contain position in metres, rotation as an x/y/z/w quaternion, and positive scale.

```ts
// When the drag starts, read the committed object from the store.
const object = store.getSnapshot().objects.find(item => item.id === selectedId);
if (!object) return;
const before = object.transform;

// During the drag, update only your temporary viewport preview.
// Do not mutate the object or call commitTransform on every pointer move.

// On release, after is the final transform calculated by your gizmo.
const result = store.commitTransform({ objectId: object.id, before, after });
if (!result.ok) {
  showError(result.error.message);
}
// Whether accepted or rejected, clear the temporary override and render
// the latest committed object from store.getSnapshot().
```

This is an integration sketch; selectedId, after and showError belong to the calling UI. The store API is implemented, but gizmo controls and preview lifecycle wiring are not part of this change.

- Success returns `{ ok: true, value: { changed, object } }`.
- `changed: false` means no undo step or subscriber update was needed. Redo stays available.
- Failure returns `{ ok: false, error: { path, message } }` and leaves the document/history unchanged.
- On Escape, discard the preview and restore the current store transform without calling commitTransform.
- End any active preview when opening another project, undoing/redoing, or switching tools. The before-value check detects a changed transform, not a session or project revision.
- The caller's before values must still match the committed transform. The store records its own original object for undo; it does not trust caller data as a restoration snapshot.
- Tiny quaternion normalization differences up to 1e-12 and opposite quaternion signs count as the same rotation. Position and scale comparisons are exact. Accepted quaternions use the existing project validator's normalization rules.
- Each successful edit sends one store notification and participates in the existing 100-step history. Saved JSON includes the result, not the undo history.

Run checks from web with `npm.cmd run test:unit` and `npm.cmd run typecheck`.
