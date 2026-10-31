# Named viewpoints

Version 2 projects contain an ordered `viewpoints` array in each scene, with at most 64 entries per scene. Each entry has a project-unique UUID `id`, a nonblank `name`, and a `camera` pose (position, quaternion rotation and vertical field of view). The editor limits entered names to 120 characters. Standard version 1 projects do not include viewpoints. A separate compatibility reader accepts older scene-branch files with up to 100 viewpoints per scene; importing them converts to version 2 and must also pass the version 2 limit. Standard Open and server validation do not use that compatibility reader.

Choose a scene, frame the camera, enter a name under Saved views, and capture. Select a saved view to revisit, rename or delete it. Revisiting changes the live camera without adding a history entry. Capturing, renaming, deleting and reordering share the project undo order. Imported files start fresh history; browser recovery retains project history within its existing bounds.

The first captured view supplies the scene's `startCamera`. Select a saved view and choose **Set as starting view** to copy its pose into `startCamera`; this is undoable. Reordering does not change the starting camera. Deleting that saved view leaves the camera pose in place. The displayed starting view is matched by pose, so if multiple views have identical poses the first match is displayed.

Version 2 content can reference viewpoints through navigation components and rules. Deleting a referenced viewpoint or scene is rejected by project validation; it does not automatically remove or repair those references. Replacing a captured pose is not implemented.

Open the saved-view picker and drag a handle to the insertion line to reorder. Move up/down buttons provide the same operation with keyboard access. Selection stays on its stable ID, the camera stays put, and previous/next follows the new order. A completed move is one undo step; cancelling the drag changes nothing.

Manual check: capture Entrance, place an object, capture Overview. Undo should remove Overview, then the object, then Entrance. Redo should restore the same IDs. Set Overview as the starting view, save and reopen, then check its pose persists. Wait for browser save before refreshing; the same mixed undo order should remain available. Revisit a view after moving the camera and check it returns to the captured pose. Visitor mode disables authoring controls.
