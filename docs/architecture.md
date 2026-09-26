# Architecture v0.1

Spatial Experience Builder (SEB), developed by Meshworks for VThere.
Reviewed 26 September 2026 against `dev` at `fcf4cb4` and its current implementation.
This is the M1 architecture baseline; the second diagram labels later product work.

## Implemented editor and data flow

```mermaid
flowchart LR
  Author[Author: browser] -->|click, key, pointer| UI[React editor controls]
  UI -->|add / transform / undo / redo| Store[Document store and history]
  Store -->|immutable committed snapshots| UI
  Store -->|objects, transforms, starting camera| View[Three.js viewport and camera modes]
  View -->|selection IDs / one transform per completed drag| UI
  Registry[Asset manifest and delivery GLBs] -->|validated catalogue at Vite build| Catalogue[Asset URLs and metadata]
  Catalogue -->|GLB fetch / GLTFLoader| View
  UI -->|open / save / autosave| Persistence[File and recovery coordinator]
  Store -->|current authored document| Persistence
  Persistence -->|validate / serialize / deserialize| Format[Shared v1 project format]
  Format -->|validated replacement| Store
  Persistence <-->|transaction with expected revision| IDB[(IndexedDB: local drafts)]
  Persistence <-->|file picker / writable stream| File[Local project JSON]
  Persistence -->|download fallback| File
  File -->|file input fallback| Persistence
```

The authored document is authoritative. React and Three.js project it; neither is a
second saved project. The store owns immutable snapshots and reversible commands;
selection and camera navigation are session state. Pointer previews and rendering
stay outside React. A completed drag produces one transform command; cancellation
produces none. The current visitor camera is inside the editor application.

The v1 document contains stable project/scene/object IDs, one environment-backed
scene, ordered asset references, transforms and a starting camera. The initial grid
has no complete project until a room is chosen or a valid file is opened.
See [project types](../web/shared/project/project-types.ts) and the
[representative fixture](../web/shared/project/fixtures/m1-project.json).

## Hosting and planned product boundary

```mermaid
flowchart LR
  Repo[Private GitHub repository] -->|PR / push: locked build and checks| CI[GitHub Actions: Ubuntu]
  CI -->|tested Docker image and release descriptor| Registry[Private GHCR]
  Registry -->|manual Deploy: exact image digest| Host[Caddy: dev and production]
  Host -->|HTTPS with team access gate: app / GLBs| Editor[Current browser editor]
  Wiki[Separate Wiki.js handbook] -->|wiki branch: content backup| Repo
  subgraph Planned[Planned M2 / M3 product components]
    API[ASP.NET Core API and Identity]
    DB[(PostgreSQL: accounts, projects, publications)]
    Assets[Protected asset storage]
    Player[Shared player: preview and separate visitor]
    API -->|EF Core / Npgsql transactions| DB
    API -->|authorize asset bytes| Assets
    Player -->|HTTPS: published snapshot and assets| API
  end
  Editor -.->|M2: authenticated HTTPS draft saves| API
  Editor -.->|M2: isolated preview snapshot| Player
```

The current application has no API or application database. Wiki.js and its database
are documentation infrastructure, separate from SEB projects. M1 IndexedDB/JSON is
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
| Recovery                           | `saveLocalDraft` / `loadLocalDraft` validate records and use expected storage revisions.                                                                    |
| Project files                      | `writeProjectFile` checks last-known disk text and commits on stream close; JSON upload/download is the fallback.                                           |
| Asset catalogue                    | `CatalogueAsset` supplies immutable ID, kind, URL, thumbnail and placement metadata from the validated manifest.                                            |
| Build and hosting                  | CI produces runnable web files and a commit identifier; branch builds also produce an immutable image and release descriptor consumed by manual deployment. |

Named owners and their existing owning Jira issues are maintained in the
[component responsibility map on SCRUM-113](https://meshworkss.atlassian.net/browse/SCRUM-113).
That planning record also identifies unassigned future components; assignments and
completion status remain outside this technical specification.

## Edit, save and reload trace

1. Choose a room, then place a crate. `App.tsx` calls `createProject`/`addObject` in
   the document store; controls and viewport receive the same stable object ID.
2. Moving commits `setTransform`; Undo restores its previous transform. The store
   publishes a new snapshot for each committed operation.
3. The coordinator in `App.tsx` captures that snapshot and edit sequence.
   `local-drafts.ts` serializes validated JSON and checks the expected storage
   revision in an IndexedDB transaction. Only a committed transaction reports success.
4. Save/Save As uses `project-files.ts`. A file write compares the last known disk
   text before replacing it; closing the writable stream confirms completion.
   Browsers without file pickers use JSON upload/download instead.
5. Reload validates the browser record and project again before `loadProject`
   replaces the store. IDs, object order, transforms and starting camera survive;
   incompatible undo history is cleared. A remembered file needs an explicit Save
   to reconnect permission. An invalid file, failed write or conflict preserves work.

Run `npm run test:recovery` from `web/` against the development server for the
place–move–undo–save–reload check and failure cases. The
[setup guide](../README.md#development) provides commands and verification limits. Asset
rights remain pending in the manifest; the diagram does not imply content approval.
