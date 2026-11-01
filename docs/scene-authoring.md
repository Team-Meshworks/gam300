# Scene authoring

A scene is a complete environment containing its objects, environment model, starting camera and named viewpoints. A room model is an asset used by a scene, not the definition of a scene.

## Using the editor

Use Scenes on the left rail. Scene tree lists objects in the active scene; Saved views manages its cameras. Choose an environment and a name to add a scene. Rename, reorder or delete scenes through this panel. Every scene requires an environment asset in the shared server format.

New returns to room selection after the existing save/discard/cancel decision. Adding a second scene or editing viewpoints upgrades a version-1 project to version 2. Version 2 supports 1–16 scenes and up to 64 viewpoints per scene, within the 5 MiB file limit. The strict version-1 reader remains unchanged.

## History and files

Scene creation, rename, reorder, environment changes and viewpoints share object undo history. Switching scenes creates no history entry and cancels an unfinished transform preview. Undo/redo selects the scene recorded for that edit. Complete document snapshots preserve other scenes, groups, components, media and rules.

Save/Open includes all scenes. Opening a file starts with fresh history. Browser recovery preserves the active scene and history within the 100-edit/20 MiB limits. Invalid history is rejected without throwing away a valid current document. New persists the empty room-selection state so discarded projects do not return after reload.

## Starting views

The saved startCamera is authoritative. Capturing the first viewpoint sets this camera; Set as starting view copies the chosen viewpoint's pose into it. Reordering or deleting viewpoints does not change that pose. The panel identifies a named starting view when its camera matches. These changes are undoable. There is no startViewpointId in the server format.

## Older scene files

Use File → Import older scene file for the earlier extended version-1 format. This is a separate compatibility reader, not a relaxed server validator. The conversion preserves IDs, scene/view order, objects and the effective starting camera. It supplies the version-2 object fields and empty groups, zones and rules. Scenes without an environment require an explicit choice. Over-limit or invalid files are rejected without trimming data. Save the conversion as a new file; the original stays unchanged. Old undo history is not converted.

A recognized older browser session offers Import older browser backup. Reading it does not rewrite it. Before the active session is replaced, its entire original recovery record is retained under an older-scene-backup revision key in the same IndexedDB transaction. Concurrent-tab revision checks still apply.

## Deleting scenes and viewpoints

Scene deletion requires confirmation, keeps at least one scene and removes the complete scene in one undo step. Undo restores its IDs, content, ordering and starting camera. If a rule references the scene or viewpoint, deletion is rejected rather than silently breaking the rule. Compound removal/restoration of dependent rules is a separate future task.

## Manual check

1. Add an environment, a crate and a named view in World A.
2. Add World B with an environment and a snowglobe; switch between both scenes.
3. Undo and redo edits; verify the other scene's content stays intact.
4. Rename and reorder scenes and views. Choose a starting view; reorder again and verify the starting camera stays unchanged.
5. Refresh after browser backup and check undo/redo. Save and reopen; check both scenes and starting cameras.
6. Import an older scene file, choose any missing environments and save the conversion separately.
7. Cancel scene deletion, then confirm it and test undo/redo. A referenced destination must reject deletion.
