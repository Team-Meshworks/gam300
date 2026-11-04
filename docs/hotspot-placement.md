# Consistent hotspot attachment

Clicking Add Hotspot and dragging it onto a placed object now use the same
object-relative upper-right/front anchor. This follows the placement in Figma
file `QNpdfKb2Ge7vO8uG8HphxB`, normal `137:40298` and selected `137:40220`.

The anchor comes from the loaded catalogue model's bounds after its authored
transforms and bottom-centre normalization. Its gap is 8% of the model's longest
dimension; the horizontal offset also clears half the existing marker width.
This avoids assuming a particular exhibit's dimensions or converting a floor
intersection into an object-local point. Owner translation, rotation and scale
carry the attachment with the object. Captions and other attached content do not
enlarge the source model's anchor bounds.

The drag identifies the owner under the pointer; dropping in empty space retains
the existing selected-object fallback. A valid object can accept a hotspot even
when the pointer ray never meets the floor. Rooms and groups remain unsupported,
and the one-hotspot-per-object rule remains in the document store.

Markers draw above scene geometry in the editor. Preview still hides these
authoring aids and uses the existing object interaction behavior.

There is no schema migration: existing hotspot positions, IDs and interaction
references are unchanged. The stored bottom-centre convention and the renderer's
half-marker vertical offset remain compatible with previous scenes. Repositioning
an old hotspot is a separate edit. The anchor is fixed in the object's coordinate
frame; orbiting the camera or turning an object away changes which side it appears
on screen. This is intentional rather than silently moving an authored anchor.

## Validation

- Ten geometry cases cover small, large, tall, wide, offset, degenerate and
  non-finite models, plus translation, rotation and nonuniform scale.
- `npm run test:hotspot-placement -- http://localhost:5175/` exercises real toolbar
  click/drag attachment on the crate, square panel and rectangular stand, including
  transformed variants, undo/redo, browser recovery, imported legacy positions,
  duplicate prevention and unsupported rooms.
- `npm run test:hotspot-rendering -- http://localhost:5175/` checks live renderer
  transforms and anchor stability, then counts actual gold marker pixels through
  an opaque occluder. It verifies hiding in Preview and restoration in the editor.
- Screenshot evidence is written to ignored `apps/web/test-results/hotspot-placement/`.

Both hotspot browser checks passed on Windows Chromium with no page errors.

The full web unit suite passes (669 tests), as do TypeScript, ESLint, architecture
checks and the production build. The existing display-tools browser check passes.
The broader `editor-shell.check.mjs` stops at line 141 because the expanded asset
library already scrolls, while the older assertion expects no scrolling. The same
failure was reproduced on unchanged published commit `a7ed0fbd` in a separate
checkout; no full editor-shell pass is claimed.

This change is local only; it has not been pushed, merged or deployed.
