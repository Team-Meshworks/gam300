# Asset pipeline baseline

## Untitled architectural model (November 2026)

The supplied `Untitled.glb` is available as **Untitled** in Asset library under
Architecture, with stable ID `library-untitled-v1`. Its full-size original is
preserved byte-for-byte at `source/library/untitled-v1.glb`. The delivery copy adds
a uniform 1:10 parent transform so the complete interior can be placed as a
2.53 × 1.09 × 3.11 metre model inside the Starter room. Geometry, materials and all
ten embedded textures are unchanged. Bottom-centre placement removes its export
offset, and the editor renders its thumbnail from the model.

The GLB is approximately 93.7 MB, including ten 4096 × 4096 textures. It follows
the existing development-only catalogue and pending provenance convention.

## Room layouts (November 2026)

The 16 user-supplied room GLBs are preserved byte-for-byte under `source/rooms/`
and `delivery/rooms/`. `Space1` and every combination of Doors 1–4 have separate
versioned environment IDs and matching placeable model IDs. The supplied numbering
guide is `source/rooms/door-reference.png`. They appear in the editor's Rooms picker
with generated elevated model previews. The first room establishes the scene
environment; a subsequent choice places its matching approved model as an adjoining
room. If no approved matching model is available, another copy cannot be placed.

Bounds in the manifest were measured from transformed vertices. Bottom-centre
normalization removes export offsets without rescaling; the environment placement
root preserves this normalization under scene transforms. These are complete
layouts, not Starter room modules. Adjoining placement snaps using the rooms' bounds
within the 80-metre grid. These layouts do not use the Starter room's automatic door
cutting. They use the existing development-only catalogue and retain pending
provenance status. Validate using `node tools/validate-assets.mjs` and, with Vite
running, `node tests/room-layouts.check.mjs http://127.0.0.1:5185/` from `apps/web/`.

## Baseline validation

Run from the repository root:

```powershell
node tools/validate-assets.mjs
```

The draft manifest catalogues the contributor-created room and crate and the legacy snowglobe sample. Paths are relative to assets/. This offline manifest is not a public browser API; never expose private storage paths through a future browser catalogue.

Offline validation lives with the other repository checks in tools/. Run `node tools/validate-assets.check.mjs` for its path-resolution, source-file and containment regression checks. Browser catalogue and loading code lives in apps/web/shared/asset-runtime/; this directory owns the binary assets and manifest.

The validator checks required baseline metadata, unique IDs, file containment/existence, byte sizes, SHA-256, the GLB header and JSON chunk, static content, required extensions, and external resources. It does not replace a full glTF validator, geometry/bounds inspection or a browser rendering test. **Do not claim T11-01 complete from this check alone.**

Outstanding: real thumbnails, confirmed distribution rights, complete GLB validation, measured bounds/pivots, environment walkPlaneY/eyeHeight/walk rectangles, browser rendering and agreed size/extension limits. Null thumbnails and pending rights produce warnings. Bounds are descriptive metadata in this draft, not yet automatically validated.  Do not fabricate metadata or silently update hashes when files change: new delivery versions require new asset IDs.

## Manual validation

Both test-room.glb and test-crate.glb passed the Khronos glTF
Validator

## Validation checks performed

- Room and crate pass manifest and Khronos glTF validation.
- A temporary truncated crate GLB was rejected with
  GLB_UNEXPECTED_END_OF_CHUNK_DATA.
- Temporary test files were removed.
- Licence approval and browser visual verification remain pending.

Other GLBs in delivery/ are intentionally not catalogued until provenance and approval are known. Original files are untouched. A .blend1 file is a Blender backup, not a required delivery asset.


## Editor catalogue integration

The Vite asset-catalogue plugin reads this manifest and exposes only test-room-v1, test-crate-v1 and sample-snowglobe-v1 as explicitly allowlisted local development samples. The browser receives IDs, names, kinds, content hashes, asset URLs, thumbnail URLs and placement metadata; it does not receive source paths, licence records or the full offline manifest. Licence approval is still pending; this is not a production publication pipeline. Other delivery files are not automatically added.

Manifest edits restart the dev server, so save/export authored work first. Builds emit the selected GLBs and thumbnails with hashed URLs from assets/delivery/. The obsolete apps/web/editor/public/models copy has been removed; do not duplicate catalogue files in the editor public directory. Source originals remain under assets/source/, separate from immutable delivery files. The room uses the project's scene environment field; model placement follows the catalogue's placement metadata.

Checks on 20 September 2026: room and crate rendered together in the browser, manifest thumbnails loaded, click placement and crate drag placement worked, and undo/redo restored the crate. Domain tests cover mixed asset IDs and unknown-ID rejection. Project saving, camera controls, transform editing and publication remain outside this change.

The snowglobe retains its stable sample-snowglobe-v1 ID, source/snowglobe.glb and delivery/snowglobe.glb. Both files intentionally retain the original bytes. thumbnailMode: generated requests the renderer-generated preview; placement: bottom-center retains the demo placement convention. animationPolicy: static-only disables playback of the animation stored in the GLB. Other animated assets are rejected unless explicitly reviewed for this policy; skinned assets remain unsupported. Licensing implementation belongs to the VThere team. The former models/snowglobe.glb demo URL is retired; saved projects resolve the unchanged asset ID through the manifest.

## Viewport resource caching

The browser catalogue now includes each delivery's verified SHA-256. Parsed models and
generated thumbnails are reused across viewport recreation with reference-counted leases,
at most three idle entries and a 30-second expiry. New bytes require a new immutable asset
ID/hash. Invalidation retires lookups without destroying active borrowers. From `apps/web/`,
run `npm run test:caching` for resource-lifetime checks or `npm run measure:caching`
to record comparable baseline/cached timings.

## Stands and displays (November 2026)

Eight user-supplied GLBs are preserved unchanged in `source/stands-displays/` and
`delivery/stands-displays/`, with immutable versioned IDs and hashes in the manifest.
Their original filenames and unconfirmed provenance are recorded there. They are
explicitly allowlisted development assets, not approved production distributions.
Generated thumbnails use the actual model renderer.

The four physical cases/plinths expose `displayRole: physical` and a `displayTop`
height relative to the bottom-centred model. Glass cases use their interior base,
not the top of the outer glass bounds. The four digital stands/panels expose
`displayRole: digital` and `displaySurface` (local position, quaternion, width and
height in metres). Surface positions were measured from transformed GLB vertex
positions, with an inset border and a small offset to prevent z-fighting. Raw
exports contain large modelling offsets; existing bottom-centre normalization
removes those offsets without changing the source geometry.

Run `node tools/validate-stands.mjs` for the eight-asset catalogue/source/delivery
contract and `node tools/validate-assets.mjs` for hashes and Khronos validation.
Browser verification remains necessary for appearance and authored media.
