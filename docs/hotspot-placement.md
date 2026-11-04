# Consistent hotspot attachment

Clicking Add Hotspot and dragging it onto a placed object use the same point just
above the visible left edge. The user's supplied upper-left screenshot and explicit
left direction supersede the earlier upper-right interpretation of Figma file
`QNpdfKb2Ge7vO8uG8HphxB`, normal `137:40298` and selected `137:40220`.

The anchor projects all eight corners of the loaded model's normalized bounds
through the object's transform and the current camera. It clears the visible top
and left edges by 4% of the longer projected dimension, accounting for the marker's
width and height. Thus an object turned 180 degrees still gets a new hotspot on
the viewer's left. The point is converted back to object-local coordinates for
saving. Captions and other attached content do not enlarge the source model bounds.

The drag identifies the owner under the pointer; dropping in empty space retains
the existing selected-object fallback. A valid object can accept a hotspot even
when the pointer ray never meets the floor. Rooms and groups remain unsupported,
and the one-hotspot-per-object rule remains in the document store.
If the model intersects or lies behind the camera's near plane, the editor asks
the author to bring it fully into view rather than inventing an unbounded position.

Markers draw above scene geometry in the editor. Preview still hides these
authoring aids and uses the existing object interaction behavior.
Their aspect ratio remains square when an owner is stretched; icon size follows
the smaller horizontal/vertical owner scale, including during transform previews.

There is no schema migration: existing hotspot positions, IDs and interaction
references are unchanged. The stored bottom-centre convention and the renderer's
half-marker vertical offset remain compatible with previous scenes. Repositioning
an old hotspot is a separate edit. "Left" means the viewer's left at attachment
time. The saved point subsequently follows the object; camera movement does not
silently edit the document or make an existing attachment chase the camera.

## Validation

- Eleven geometry cases cover small, large, tall, wide, offset, degenerate,
  non-finite and camera-clipped models, different camera angles, translation,
  180-degree rotation and nonuniform scale.
- `npm run test:hotspot-placement -- http://localhost:5175/` exercises real toolbar
  click/drag attachment on the crate, square panel and rectangular stand, including
  six variants, undo/redo, browser recovery, imported legacy positions,
  duplicate prevention and unsupported rooms.
- `npm run test:hotspot-rendering -- http://localhost:5175/` checks live renderer
  transforms and preservation of legacy positions, then counts gold marker pixels through
  an opaque occluder. It verifies hiding in Preview and restoration in the editor.
- Screenshot evidence is written to ignored `apps/web/test-results/hotspot-placement/`.

Both hotspot browser checks passed on Windows Chromium with no page errors.

The full web unit suite passes (670 tests), as do TypeScript, ESLint, architecture
checks and the production build. The broader `editor-shell.check.mjs` now passes.
Its prior scrolling assertion incorrectly treated the entire expanded catalogue
as a short list. It now searches for one real asset before comparing short and
long layouts; category availability follows the actual user-facing catalogue.
The test retains its scrolling and horizontal-overflow assertions.

The display-tools browser check verifies that all eight internal registrations
still place from their toolbar controls and survive saving/reloading, while
stands and displays are absent from the general library/search. The display-editor
check also verifies exclusion from physical-content choices and retention of
regular content models.

This change is local only; it has not been pushed, merged or deployed.
