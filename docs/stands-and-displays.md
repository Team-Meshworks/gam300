# Stands and displays

The editor now reuses v2 content components and attached-object transforms for display authoring.

## Authoring

1. Choose a room, then use the Display panels or Display cases toolbar popup (or asset library) to place one of the seven supplied models.
2. Select the placed display and choose **Edit display content**.
3. For physical displays, choose a model to place at its measured support height. The model is attached to the display and follows its transforms. The existing single-slot replacement/removal commands and undo history are reused.
4. For digital displays, choose Text, Photo or Video. Text supports whole-panel bold, italic and underline, with an optional caption. Apply or Remove content is one undoable document change. Cancel leaves the document untouched.
5. Preview renders the digital surface. Video playback requires a click on its display or its Play / pause button; leaving Preview, hiding the page or removing the object pauses playback.

## Boundaries

- The supplied inputs contain seven GLBs and a visual reference, not photo/video media. Photo and Video pickers therefore show an explicit empty-library message until approved media are registered. This is not an arbitrary file-upload or external URL feature.
- Typed media registry selection and rendering are implemented. Actual registered media files still require provenance, immutable IDs/hashes, delivery configuration and corresponding asset validation. No external media or redistribution rights were invented.
- Display metadata is local to bottom-centered GLB geometry. Existing world-space transforms remain the saved contract, avoiding a project-format migration.
- The editor renders one text/image/video component per digital display. Content on other model types remains blocked from Preview instead of silently disappearing.
- Existing component IDs and unrelated components are preserved; validation rejects dangling references when content removal would invalidate a rule.
- Provided GLBs remain development-only pending distribution-rights confirmation.

## Verification

TypeScript, ESLint, architecture checks, production build, all 657 unit tests, full asset validation and the stand contract check passed in the cloud workspace. Browser checks could not start: bundled Playwright Chromium was unavailable, and system Chromium failed at OS socket creation. No visual browser or end-to-end playback pass is claimed. The server development catalogue allowlist was updated for the seven GLBs with regression cases; those C# tests were not run because the .NET SDK is unavailable in this workspace.

The toolbar was subsequently checked on Windows with Playwright Chromium: all seven SVGs render at 40 × 40 inside their popup and selected toolbar buttons; both trays dismiss/reopen and keyboard placement adds all seven displays. The check creates a room before placement and keeps the scene tree open. Default browser button padding was removed to keep the SVGs inside their slots. TypeScript and the 12 focused display unit tests also passed locally. These checks do not cover end-to-end media playback or the C# tests.

Figma references: Meshworks M2 image `152:62291`, video `152:62332`, text `152:62374`, digital tray `152:59981`, physical tray `152:61951`; placement flow `592:1965`. M1 Final examples `137:41514` and `137:41356` show plinth objects with separate text/photo stands.
