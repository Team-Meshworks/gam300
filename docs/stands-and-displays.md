# Stands and displays

The editor now reuses v2 content components and attached-object transforms for display authoring.

## Authoring

1. Choose a room, then use the Display panels or Display cases toolbar popup (or asset library) to place one of the eight supplied models.
2. Select the placed display and choose **Edit display content** beside the scene tools. The contextual action follows the dock and stays outside the header.
3. For physical displays, choose a model to place at its measured support height. The model is attached to the display and follows its transforms. The existing single-slot replacement/removal commands and undo history are reused.
4. For digital displays, choose Text, Image or Video. Text supports whole-panel bold, italic and underline, with an optional plain-text caption. Add, Save or Remove content is one undoable document change. Close or Escape leaves the document untouched. Arrow keys, Home and End switch tabs; text and media choices survive tab changes. Unchanged mixed text runs and existing media playback options are preserved.
5. Preview renders the digital surface. Video playback requires a click on its display or its Play / pause button; leaving Preview, hiding the page or removing the object pauses playback.

## Boundaries

- The supplied inputs contain eight GLBs and visual references, not image/video media. Image and Video pickers show an explicit empty-library message with Add disabled until approved media are registered. Search and filters never erase an existing selection.
- The physical picker uses real generated thumbnail cards, category filters and persistent favourites. Physical captions and formatted captions are omitted because the current project/rendering contract does not support them. Digital captions remain plain text; formatting controls apply to the whole display text.
- Typed media registry selection and rendering are implemented. Actual registered media files still require provenance, immutable IDs/hashes, delivery configuration and corresponding asset validation. No external media or redistribution rights were invented.
- Display metadata is local to bottom-centered GLB geometry. Existing world-space transforms remain the saved contract, avoiding a project-format migration.
- The editor renders one text/image/video component per digital display. Content on other model types remains blocked from Preview instead of silently disappearing.
- Existing component IDs and unrelated components are preserved; validation rejects dangling references when content removal would invalidate a rule.
- Provided GLBs remain development-only pending distribution-rights confirmation.

## Verification

TypeScript, ESLint, architecture checks, production build, all 657 unit tests, full asset validation and the stand contract check passed in the cloud workspace. Browser checks could not start: bundled Playwright Chromium was unavailable, and system Chromium failed at OS socket creation. No visual browser or end-to-end playback pass is claimed. The server development catalogue allowlist was updated for the seven GLBs with regression cases; those C# tests were not run because the .NET SDK is unavailable in this workspace.

The toolbar was subsequently checked on Windows with Playwright Chromium: all seven SVGs render at 40 × 40 inside their popup and selected toolbar buttons; both trays dismiss/reopen and keyboard placement adds all seven displays. The check creates a room before placement and keeps the scene tree open. Default browser button padding was removed to keep the SVGs inside their slots. TypeScript and the 12 focused display unit tests also passed locally. These checks do not cover end-to-end media playback or the C# tests.

Figma references: Meshworks M2 image `152:62291`, video `152:62332`, text `152:62374`, digital tray `152:59981`, physical tray `152:61951`; placement flow `592:1965`. M1 Final examples `137:41514` and `137:41356` show plinth objects with separate text/photo stands.

## Figma editor iteration — 4 November 2026

Implemented locally from remote head `68253eb` on branch `display-editor-figma`.
The large native modal follows the Text/Image/Video and physical `160:64163` frames,
with responsive scrolling, native focus containment and trigger-focus restoration.
The square panel's original 7,292 bytes are preserved in source and delivery. SHA-256:
`fdd9139e74ba98d5a1eee8652076353130ba51bbfafb7528c7e71c42c965f167`.
Transformed geometry measures 1 × 1 × 0.1 metres; its inset content surface is
0.91 × 0.91 metres at `[0, 0.5, 0.054]` after bottom-centre normalization.

Media-library options for a subsequent decision:

- Register a small reviewed set of image/video files through the current immutable
  catalogue, hashes, provenance and delivery pipeline. This is the smallest scope.
- Add a project-scoped upload flow backed by authenticated storage, asset metadata,
  validation, quotas, thumbnails and lifecycle handling. This requires a separate
  storage/access design and cannot be enabled by a file-picker button alone.

No upload backend, production deployment or branch publication is included here.

Local verification: TypeScript, ESLint, Prettier, production build and architecture
checks passed; all 659 web unit tests passed. The eight-display byte/hash/metadata
contract and Khronos delivery validation passed with zero errors (the existing
12 distribution-provenance warnings remain). All 11 targeted server document-service
tests passed, including the expanded development catalogue.

`npm run test:display-tools -- http://localhost:5175/` verifies all eight native-size
SVGs, tray dismissal and keyboard placement. `npm run test:display-editor --
http://localhost:5175/` verifies the unobscured action at all four dock edges and
phone/tablet sizes; text dialogs at 1440×1024, 768×1024, 390×844 and 844×390; tabs,
empty media states, text/format/caption persistence, cancel, focus return, undo/redo,
physical search/favourites, phone filter dismissal, attachment and removal. Both
passed with no page errors. Screenshots are in the ignored web `test-results/display-editor/`
directory. Square-panel placement and content-surface alignment were also inspected
in the visible browser. No end-to-end image/video playback is claimed without media.
