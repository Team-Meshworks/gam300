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

Other GLBs in delivery/ are intentionally not catalogued until provenance and approval are known. Original files are untouched. A .blend1 file is a Blender backup, not a required delivery asset.

