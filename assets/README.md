# Asset pipeline baseline

Run from the repository root:

```powershell
node assets/tools/validate-assets.mjs
```

The draft manifest catalogues only the contributor-created room and crate. Paths are relative to assets/. This offline manifest is not a public browser API; never expose private storage paths through a future browser catalogue.

The validator checks required baseline metadata, unique IDs, file containment/existence, byte sizes, SHA-256, the GLB header and JSON chunk, static content, required extensions, and external resources. It does not replace a full glTF validator, geometry/bounds inspection or a browser rendering test. **Do not claim T11-01 complete from this check alone. Browser verification is pending.

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

The Vite asset-catalogue plugin reads this manifest and exposes only test-room-v1 and test-crate-v1 as explicitly allowlisted local development samples. The browser receives IDs, names, kinds, asset URLs and thumbnail URLs; it does not receive source paths, licence records or the full offline manifest. Licence approval is still pending; this is not a production publication pipeline. Other delivery files are not automatically added.

Manifest edits restart the dev server, so save/export authored work first once saving is implemented. Builds emit the selected GLBs and thumbnails with hashed URLs; no manual copying into apps/web/editor/public is required. Existing public files from the teammate's demo remain unchanged. The instance group applies placement transforms without recentering or scaling the exported GLB. The room is a placeable environment sample for integration, not yet the full project's dedicated scene-environment field.

Checks on 20 September 2026: room and crate rendered together in the browser, manifest thumbnails loaded, click placement and crate drag placement worked, and undo/redo restored the crate. Domain tests cover mixed asset IDs and unknown-ID rejection. Project saving, camera controls, transform editing and publication remain outside this change.

The existing snowglobe is also selectable alongside the manifest assets. It retains sample-snowglobe-v1 and its public/models/snowglobe.glb file, generates a thumbnail at load time, and preserves the original demo bottom-centre placement convention. It remains a separate legacy development sample; adding it to the UI does not assert asset rights approval or add it to the offline manifest validation.

## Viewport resource caching

The browser catalogue now includes each delivery's verified SHA-256. Parsed models and
generated thumbnails are reused across viewport recreation with reference-counted leases,
at most three idle entries and a 30-second expiry. New bytes require a new immutable asset
ID/hash. Invalidation retires lookups without destroying active borrowers. From `apps/web/`,
run `npm run test:caching` for resource-lifetime checks or `npm run measure:caching`
to record comparable baseline/cached timings.

## Snowglobe manifest migration


All three UI samples now resolve through manifest.json and the same GLB validator. The original snowglobe bytes are retained in source/snowglobe.glb and delivery/snowglobe.glb; the existing public demo file is left intact for compatibility. Its stable sample-snowglobe-v1 ID is unchanged. thumbnailMode: generated requests the existing renderer-generated preview; placement: bottom-center retains its prior placement. animationPolicy: static-only explicitly disables playback of the animation stored in the GLB. Other animated assets are still rejected unless explicitly reviewed for this policy; skinned assets remain unsupported. Licensing implementation is owned by the VThere team. This supersedes the earlier separate-legacy-sample description.
