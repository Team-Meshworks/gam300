# Asset pipeline baseline

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

The Vite asset-catalogue plugin reads this manifest and exposes only test-room-v1, test-room-module-v1, test-crate-v1 and sample-snowglobe-v1 as explicitly allowlisted local development samples. The browser receives IDs, names, kinds, content hashes, asset URLs, thumbnail URLs and placement metadata; it does not receive source paths, licence records or the full offline manifest. Licence approval is still pending; this is not a production publication pipeline. Other delivery files are not automatically added.

Manifest edits restart the dev server, so save/export authored work first. Builds emit the selected GLBs and thumbnails with hashed URLs from assets/delivery/. The obsolete apps/web/editor/public/models copy has been removed; do not duplicate catalogue files in the editor public directory. Source originals remain under assets/source/, separate from immutable delivery files. Newly placed rooms, including the first room, use the selectable model asset test-room-module-v1, which references the same GLB as the environment asset. Both entries declare a 10 m by 10 m footprint; the model asset links back to its environment asset. Rooms move on the floor at Y=0, snap to a 1 m X/Z grid or nearby room edges, and reject overlapping placements. In legacy scenes, Make room movable converts the fixed environment into a model object and can be undone. Doorway creation is not implemented. Model placement otherwise follows the catalogue's placement metadata.

Checks on 20 September 2026: room and crate rendered together in the browser, manifest thumbnails loaded, click placement and crate drag placement worked, and undo/redo restored the crate. Domain tests cover mixed asset IDs and unknown-ID rejection. Project saving, camera controls, transform editing and publication remain outside this change.

The snowglobe retains its stable sample-snowglobe-v1 ID, source/snowglobe.glb and delivery/snowglobe.glb. Both files intentionally retain the original bytes. thumbnailMode: generated requests the renderer-generated preview; placement: bottom-center retains the demo placement convention. animationPolicy: static-only disables playback of the animation stored in the GLB. Other animated assets are rejected unless explicitly reviewed for this policy; skinned assets remain unsupported. Licensing implementation belongs to the VThere team. The former models/snowglobe.glb demo URL is retired; saved projects resolve the unchanged asset ID through the manifest.

## Viewport resource caching

The browser catalogue now includes each delivery's verified SHA-256. Parsed models and
generated thumbnails are reused across viewport recreation with reference-counted leases,
at most three idle entries and a 30-second expiry. New bytes require a new immutable asset
ID/hash. Invalidation retires lookups without destroying active borrowers. From `apps/web/`,
run `npm run test:caching` for resource-lifetime checks or `npm run measure:caching`
to record comparable baseline/cached timings.
