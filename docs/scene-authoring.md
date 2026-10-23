# Scene authoring

A scene is a complete environment containing its objects, optional environment model, starting camera and named viewpoints. A room model is one possible asset within that environment; it does not define what a scene is.

## Using the editor

Use the Scenes button on the left editor rail. Scene tree lists objects in the active scene; Saved views manages that scene’s camera views. Enter a name and choose Add scene to create a separate empty scene. Click a scene to edit it. Rename the selected scene with the name field. Drag the handles to reorder scenes, or use Move scene up/down. Environment is optional; None removes only that environment model and keeps placed objects and views.

New creates a separate project with one empty scene. The existing save/discard/cancel confirmation still applies. A project supports 1–20 scenes, each with up to 200 objects and 100 saved views, within the existing 5 MiB project limit.

## History and files

Scene creation, renaming, ordering and environment changes use the same undo history as objects and viewpoints. Switching scenes is navigation and creates no undo entry. Undo/redo selects the scene recorded for that edit. Switching cancels an unfinished transform preview.

JSON Save/Open includes all scenes in order and their objects, environment and viewpoints. Opening a JSON file starts on the first scene with fresh history. Browser recovery also preserves the active scene and the shared undo/redo history, within the existing 100-edit/20 MiB limits. New multi-scene history stores complete document snapshots; old single-scene recovery data is still readable. Invalid recovery history is rejected without replacing a valid scene document.

The schema still uses version 1, extended to allow multiple scenes and a null environmentAssetId. Existing single-scene files remain readable. Coordinate this extension with the serialization owner before merging: older validators may reject new files.

## Manual check

1. Create World A, place a crate and capture a named viewpoint.
2. Create World B: its object list and views start empty. Add a snow globe.
3. Switch back to A: the crate and viewpoint are still there.
4. Undo: B becomes active and its snow globe is removed. Redo restores it.
5. Rename/reorder scenes; undo and redo each action.
6. Wait for the browser backup, refresh, and repeat Undo/Redo.
7. Save and reopen the JSON: both scenes and their contents return in saved order.

## Starting views

Select a saved view, then choose Set as starting view. The panel shows the chosen name. Entering the scene uses its position, rotation and field of view. This choice is saved and undoable. Renaming or reordering the view keeps the choice. Deleting the chosen viewpoint uses the first remaining saved view. If no views remain, its last camera pose is the fallback; Undo restores the named reference too.

The optional startViewpointId must reference a viewpoint in that same scene, with a matching startCamera. When no starting view is explicitly chosen, the first saved viewpoint is used. Reordering changes that default. Scenes with no saved viewpoints use startCamera. Full document recovery snapshots preserve changes to this choice.

## Deleting scenes

Delete scene shows the scene name and object/view counts before confirmation. Cancel leaves it untouched. Confirmation removes the complete scene in one shared undo step. If it was active, the editor selects the next scene, or the previous one when deleting the last in order. The final remaining scene cannot be deleted. Undo restores the exact IDs, order, objects, viewpoints, environment and starting camera; Redo removes it again. Recovery preserves this history.

Navigation links do not exist in the current project schema. Removing/restoring incoming navigation references remains an integration task when that schema is introduced; this implementation does not invent or silently discard unsupported link data.

Manual checks: choose a starting view, switch away and back, then save/reopen. Delete a populated scene, confirm, Undo and Redo. Cancel a deletion and verify that the last scene cannot be deleted.
