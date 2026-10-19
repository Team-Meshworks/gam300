# Named viewpoints

Each scene can carry an optional ordered `viewpoints` array. Each entry has a project-unique UUID `id`, a nonblank `name` (maximum 120 characters), and `camera` using the existing CameraPose (position, quaternion rotation, vertical field of view). The limit is 100 views per scene.

Old schemaVersion 1 files without this optional field remain readable and retain their shape. This is an additive extension in this editor, not a promise that older editor builds can open files containing viewpoints. Coordinate this field with SCRUM-50 before merging; multi-scene support and a wider format migration remain separate work.

Choose a room, frame the camera, enter a name under Saved views, and capture. Choose a saved view to revisit, rename or delete it. Revisiting only changes the live camera and does not enter history. Capturing, renaming and deleting share the object-edit undo order. Imported files retain views but start fresh history; browser recovery retains both objects and viewpoint edits, within the existing 100-edit/20 MiB bounds. Old object-only recovery records still load.

The existing startCamera remains separate. Navigation actions, incoming references, replacing a captured pose and choosing a viewpoint as the scene starting view are not implemented here. Deletion currently has no navigation references to repair because that graph does not exist in the current schema. Extend that command before introducing those references.

Manual check: capture Entrance, place an object, capture Overview. Undo should remove Overview, then the object, then Entrance. Redo should restore the same IDs. Save/open should keep names and poses. Wait for browser save before refreshing; the same mixed undo order should remain available. Revisit a view after moving the camera and check it returns to the captured pose. Visitor mode disables authoring controls.

Open the saved-view picker and drag a handle to the insertion line to reorder. Move up/down buttons provide the same operation with keyboard access. Selection stays on its stable ID, the camera stays put, and previous/next follows the new order. A completed move is one undo step; cancelling the drag changes nothing.
