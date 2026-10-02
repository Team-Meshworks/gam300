# Architecture v0.1

Spatia, developed by Meshworks for VThere.
Reviewed 26 September 2026 against `dev` at `fcf4cb4` and its current implementation.
This is the M1 architecture baseline; the second diagram labels later product work.
Recovery and viewport boundaries below were updated on 29 September against `ada62a1`
and the audit fixes on `fix/editor-audit`.

## Implemented editor and data flow

```mermaid
block-beta
  %% Four components per row, separated by spaces for the arrow labels
  columns 7
  author["Author"] space ui["React controls"] space store["Project + undo"] space view["Three.js view"]
  space:7
  file["Project JSON"] space persistence["Save / open"] space format["Project v1"] space catalogue["Catalogue"]
  space:7
  space:2 idb[("IndexedDB")] space:3 registry["GLB manifest"]

  author --> ui
  ui -- "commands" --> store
  store -- "snapshots" --> view
  ui -- "open / save" --> persistence
  persistence -- "validate" --> format
  format -- "load" --> store
  persistence -- "read / write" --> file
  persistence -- "recovery" --> idb
  registry -- "build" --> catalogue
  catalogue -- "load GLB" --> view
```

Read the top row left to right. Saving branches down from the controls; asset loading
runs up the right side. Controls also receive document snapshots and viewport
selection/drag results. Saving captures the current document; files and IndexedDB
support both reading and writing. These return paths are omitted from the drawing
to keep the main connections clear.

The authored document is authoritative. React and Three.js project it; neither is a
second saved project. The store owns immutable snapshots and reversible commands;
selection and camera navigation are session state. Pointer previews and rendering
stay outside React. A completed drag produces one transform command; cancellation
produces none. The current visitor camera is inside the editor application. Entering
visitor mode or a project-switching decision cancels pending transform previews;
visitor navigation cannot invoke authoring controls or file saving.

The v1 document contains stable project/scene/object IDs, one environment-backed
scene, ordered asset references, transforms and a starting camera. The initial grid
has no complete project until a room is chosen or a valid file is opened.
See [project types](../web/shared/project/project-types.ts) and the
[representative fixture](../web/shared/project/fixtures/m1-project.json).

## Hosting and planned product boundary

```mermaid
block-beta
  %% Four components per row, folding right-to-left after the first row
  columns 7
  wiki["Wiki.js"] space repo["Private GitHub"] space ci["GitHub Actions"] space registry["Private GHCR"]
  space:7
  api["API + Identity"] space player["Shared player"] space editor["Browser editor"] space host["Caddy hosting"]
  space:7
  db[("PostgreSQL")] space assets["Asset storage"] space:4

  wiki -- "backup" --> repo
  repo -- "PR / push" --> ci
  ci -- "image" --> registry
  registry -- "manual deploy" --> host
  host -- "HTTPS" --> editor
  editor -- "preview" --> player
  player -- "HTTPS" --> api
  api -- "EF Core" --> db
  api -- "authorize" --> assets

  classDef planned fill:#fff4d6,stroke:#8a6116,color:#35270c,stroke-dasharray:5 4
  class api,player,db,assets planned
```

Read across the top row, down at GHCR, then right to left through the second row.
The API branches down to the two data stores. **Dashed amber boxes are planned M2/M3
components.** The editor will also save drafts directly to the API over authenticated
HTTPS; that direct connection is described here to avoid a line through the player.

CI uses Ubuntu and produces a tested Docker image plus its release descriptor.
Manual deployment selects the exact image digest for development or production.
Caddy serves the app and GLBs behind the team access gate. The planned API uses
ASP.NET Core/Identity and EF Core/Npgsql; the shared player serves both editor preview
and the separate visitor application.

The current application has no API or application database. Wiki.js and its database
are documentation infrastructure, separate from Spatia projects. M1 IndexedDB/JSON is
local recovery and interchange. M2 adds durable PostgreSQL projects/accounts; M3
publication uses persisted snapshots and server-enforced access. The separate visitor
build must exclude authoring code. See [deployment](deployment.md).

## Interfaces and responsibility

| Component                          | Current boundary contract                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor controls                    | Read document/selection snapshots and invoke commands; do not maintain a second saved scene.                                                                |
| Document store and history         | `createProject`, `loadProject`, `addObject`, `setTransform`, Undo/Redo and commit subscriptions.                                                            |
| Three.js viewport and manipulation | Project document objects into meshes; report stable selection IDs and commit one transform after a completed drag.                                          |
| Project format                     | Validate raw JSON and asset kinds before reconstruction; serialize stable IDs, ordered objects, transforms and starting camera.                             |
| Recovery                           | `useProjectSession` coordinates manual file saves and quiet backups; `saveRecoverySession` / `loadRecoverySession` validate the active session and use expected storage revisions. Legacy drafts remain readable for migration. |
| Project files                      | `writeProjectFile` checks last-known disk text and commits on stream close; JSON upload/download is the fallback.                                           |
| Asset catalogue                    | `CatalogueAsset` supplies immutable ID, kind, URL, thumbnail and placement metadata from the validated manifest.                                            |
| Build and hosting                  | CI produces runnable web files and a commit identifier; branch builds also produce an immutable image and release descriptor consumed by manual deployment. |

Named owners and their existing owning Jira issues are maintained in the
[deliverables and ownership plan](deliverables.md) and the
[component responsibility map on SCRUM-113](https://meshworkss.atlassian.net/browse/SCRUM-113).
That planning record also identifies unassigned future components; assignments and
completion status remain outside this technical specification.

## Edit, save and reload trace

1. Choose a room, then place a crate. `App.tsx` calls `createProject`/`addObject` in
   the document store; controls and viewport receive the same stable object ID.
2. Moving commits `setTransform`; Undo restores its previous transform. The store
   publishes a new snapshot for each committed operation.
3. `use-project-session.ts` captures committed document and history snapshots after
   a two-second editing pause. `local-drafts.ts` writes them with the last manual-save
   baseline to one active IndexedDB record, checking the expected storage revision.
   Only a committed transaction reports success. Backup failures pause retries until Save.
4. Save/Save As uses `project-files.ts`. A file write compares the last known disk
   text before replacing it; closing the writable stream confirms completion.
   Browsers without file pickers use JSON upload/download instead. Downloads do not
   confirm disk completion or clear the dirty state, but Save still retries recovery.
5. Reload validates the browser record and project again before `loadProject`
   replaces the store. IDs, object order, transforms and starting camera survive;
   valid undo history and the file's dirty state are restored. Invalid history is
   discarded with a warning while keeping the scene. A remembered file needs an
   explicit Save to reconnect permission. Legacy migration offers the newest readable
   backup when another is damaged, retaining rejected records. New/Open asks about
   unsaved changes and commits the replacement backup before changing the visible
   project. An invalid file, failed write or conflict preserves work.

Run `npm run test:recovery`, `npm run test:history` and `npm run test:integration`
from `web/` against the development server for persistence and viewport integration
checks. CI runs these alongside the editor shell suite. The
[setup guide](../README.md#development) provides commands and verification limits. Asset
rights remain pending in the manifest; the diagram does not imply content approval.

## Enforced source modules — TI-01

The current browser modules below are implemented. The server, shared player and
separate visitor application in the earlier target diagram remain future work.
`ModeManager`'s visitor camera is still part of the editor renderer. These boundaries
group existing files by responsibility; they do not introduce packages or empty folders.

| Module | Implemented responsibility and public contract | Permitted module imports |
| --- | --- | --- |
| project | `shared/project/`: v1 plain data, validation, JSON reader/writer, spatial validation, limits and the representative JSON fixture. Internal structure validation stays private. | None |
| catalogue | `shared/assets/` metadata and virtual-module declaration, excluding `ModelCache.ts`. `CatalogueAsset`, drag MIME type and legacy sample descriptor. No asset loading or rendering. | None |
| asset-loading | `shared/assets/ModelCache.ts`: acquire/release model leases, invalidate cached versions and reclaim owned Three.js resources. | catalogue |
| input | `editor/history-shortcuts.ts`: keyboard/text-focus guards and callbacks. It owns no document or renderer. | None |
| document | `document-store.ts`, `command-history.ts`, `transform-command.ts`, `recovery-history.ts`: immutable authored snapshots, reversible commands, transform sessions and validated recovery history. Consumers use the store and recovery-history contracts. | project, catalogue |
| rendering | `editor/graphics/` and `editor/controls/`: scene projection, picking, navigation, custom gizmos and drag overlays. Public entry points are `scene.ts` and `modeManager.ts`. | project, catalogue, input, asset-loading |
| persistence | `editor/persistence/`: native project-file access, revisioned IndexedDB recovery and React session coordination. The editor uses `useProjectSession`; storage implementation files are private outside checks. | project, catalogue, document |
| editor | Remaining `editor/` files: React composition, viewport lifecycle, confirmation controls, HTML and CSS. It invokes document commands and passes renderer callbacks. | project, catalogue, input, document, rendering, persistence |
| build | Root web configuration, asset-catalogue generation and architecture tooling. | None |
| checks | All `.test.ts` files, `tests/` browser drivers and `architecture.check.mjs`. These are consumer checks, including tests co-located with production code. | All eight application modules and build |

The exact file definitions, public-file allowlists, package restrictions and permitted
edges live in [architecture.mjs](../web/architecture.mjs). Same-module imports remain
local. Production code cannot import checks, another module's private implementation,
or an undeclared module. `project`, `catalogue`, `input` and `document` cannot import
external packages. Three.js belongs to rendering and asset-loading; React belongs
to editor and persistence. Build/checks may use installed tooling and Node built-ins.

Authored state remains owned by the document store. Rendering sends completed edits
through callbacks; it cannot import the store or commands. A drag commits once, and
visitor navigation never writes the draft. Recovery-history validation moved from
persistence into document, removing the document–persistence cycle. Its record shape,
portable JSON and history behavior are unchanged.

### Import enforcement and reproducible graph

From `web/`:

```sh
npm run graph:architecture  # regenerate from actual imports and source hashes
npm run check:architecture  # enforce boundaries/cycles and reject a stale graph
npm run test:architecture   # disposable violations and per-module removal checks
```

The [generated graph](architecture-graph.md) and
[file/line import inventory](architecture-graph.json) include static imports,
type-only imports, re-exports, import-type queries, literal dynamic imports,
literal CommonJS imports and automatic JSX runtime imports. TypeScript's installed resolver handles extensionless,
explicit `.ts`, `.js` substitution, directory indexes and configured aliases.
Vite query suffixes, editor-root URLs and the generated catalogue contract are
resolved explicitly. Casing and missing/unassigned source fail the check.
Computed production imports and import globs fail closed.

The existing browser drivers select Playwright from an environment override and
load transformed Three.js/cache URLs to instrument the same module instances.
Those exact test expressions have explicit mappings in the checker and are listed
as computed imports in the inventory. The caching measurement's pinned Git renderer
is a generated test module, recorded as such. Other computed test imports fail.
Generated catalogue imports refer to the metadata contract; GLB/image bytes and
manifest reads are resources, not additional JavaScript modules. HTTP navigation by
browser tests is an editor host dependency, separate from the source-import graph.

CI checks the graph on Ubuntu, Windows and macOS. Ubuntu installs the pinned browser,
then runs the violation/removal proof before the full browser suites. These workflow
changes do not themselves prove a remote CI run succeeded.

### Isolated removal evidence

[architecture.check.mjs](../web/architecture.check.mjs) copies the current web source
into disposable directories and removes each module's assigned source/resources
there. It uses separate TypeScript programs rooted in each surviving module, reports
every failure and compares them with the permitted reverse dependency closure.
Checks also exercise their real tooling import and the browser editor entry, covering
the host dependency that is not a static source import. Unrelated unit tests run with
their original dependency chains. There are no deletions in the active checkout;
read-only dependency/asset links are outside the deleted source groups.

The runner writes diagnostics, observed/expected affected modules, unrelated checks
and source hashes to `web/test-results/architecture-proof.json`, retained with CI test
artifacts. Re-run the proof when module contracts
change; a clean drawing alone does not establish this claim.
