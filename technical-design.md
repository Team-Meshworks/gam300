---
title: Technical Design
description: Current architecture, authored data and the planned editor/player/server boundaries.
published: true
date: 2026-10-02T14:57:27.236Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:59:57.495Z
---

# Technical design

This page describes published **dev 8f05c07**, reviewed on 2 October 2026, and labels later product work separately. The tracked [architecture v0.1](https://github.com/Team-Meshworks/gam300/blob/dev/docs/architecture.md) is the detailed component contract. Named responsibilities are maintained on [SCRUM-113](https://meshworkss.atlassian.net/browse/SCRUM-113); the [M1 mapping](/en/testing) holds the ownership/status snapshot.

## Stack and status

| Area | Current implementation | Planned extension |
| --- | --- | --- |
| UI | React 19, TypeScript 6, Vite 8, native HTML/CSS | Radix UI where a complex accessible primitive is needed |
| 3D | Direct Three.js and GLB loading | Curated content library and measured asset budgets |
| Editing | Document store, commands/history, custom translation | Content/rules, rotate/scale and multi-scene authoring |
| Data | Validated v1 project reader/serializer and fixture | v2 content/rules, migration and server validation |
| Local persistence | IndexedDB session/history recovery and JSON Open/Save/Save As | Durable PostgreSQL-backed projects/accounts in M2 |
| Runtime | Editor/visitor camera mode in the editor application | Shared player for preview and a separate visitor build |
| Backend | Not present in this baseline | ASP.NET Core Identity, EF Core/Npgsql and PostgreSQL |
| Delivery | Docker/Caddy, GitHub Actions, separate dev/prod deployments | Application accounts and persisted publication |

## Implemented data and editing flow

~~~mermaid
flowchart LR
  UI[React controls] -->|Commands| Store[Authored document and undo history]
  Store -->|Snapshots| View[Three.js viewport]
  UI --> Files[Open and Save]
  Files -->|Validate| Format[Project v1]
  Format -->|Load| Store
  Files <--> JSON[Project JSON file]
  Store -->|Quiet session backup| IDB[(IndexedDB)]
  IDB -->|Validated recovery| Store
  Manifest[Asset manifest] --> Catalogue[Catalogue]
  Catalogue -->|Load GLB| View
~~~

The authored document is authoritative. React and Three.js are projections, not separate saved project models. Edits request commands; history records reversible operations. Selection is shared between viewport and object list. Pointer previews and frame updates stay outside React; one completed drag commits one transform command, while cancellation commits none.

Entering visitor mode or a project-switching decision cancels pending manipulation. Visitor navigation cannot invoke authoring controls or file saves. The current camera toggle remains inside the editor; it does not establish the separate visitor-build boundary.

## Project data

The v1 document has stable project/scene/object IDs, one environment-backed scene, ordered asset references, transforms and a starting camera. The initial grid becomes a complete saveable project after choosing a room or opening a valid file.

Positions use metres. Rotations use normalized quaternions in x/y/z/w order. Scale components are finite and positive. Validate references and numeric values at import/server boundaries; TypeScript types alone do not validate untrusted JSON.

Rejected loads preserve the document and history. File replacement clears incompatible history; browser recovery restores validated session history. Invalid recovered history is discarded with a warning while preserving the scene.

## Edit, save and reload trace

1. Choose a room, place a crate and move it. The document store publishes committed snapshots with stable object IDs. Undo restores the previous transform.
2. After a two-second editing pause, **useProjectSession** captures the document/history and last manual-save baseline. **saveRecoverySession** validates them and writes the active IndexedDB record with an expected revision. Success requires a committed transaction.
3. Save/Save As uses **writeProjectFile**. It compares last-known disk content before replacement and confirms completion when the writable stream closes. Browsers without file pickers use JSON upload/download; downloads do not clear dirty state because disk completion is unconfirmed.
4. Reload validates the record and project before replacing the store. IDs, order, transforms, starting camera, valid Undo/Redo and the file dirty state return. Save reconnects permission for a remembered file.
5. New/Open asks about unsaved edits and commits the replacement backup before switching the visible project. Invalid files, failed writes and conflicts preserve work. Failed backups pause retries until Save; legacy recovery asks before using another readable backup and retains damaged records.

Browser recovery is local to the browser. Saved/Not saved refers to the project JSON file. Neither is server persistence. See [Using SEB](/en/user-guide) and the [recovery/history CI results](/en/testing).

## Planned product boundaries

~~~mermaid
flowchart LR
  Author[Author] --> Editor[Editor and commands]
  Editor --> Draft[Authored project data]
  Draft --> Preview[Shared player in preview]
  Editor --> API[ASP.NET Core API]
  API --> DB[(PostgreSQL)]
  API --> Assets[Protected asset storage]
  DB --> Snapshot[Publication snapshot]
  Snapshot --> Visitor[Separate visitor using shared player]
~~~

API, accounts, application database, shared player and publication above are planned M2/M3 work. Wiki.js's database is separate infrastructure. Runtime camera, visibility, media and interaction state cannot mutate the authored draft. The visitor build must exclude authoring code.

## Required engineering boundaries

- Implement our own gizmos, domain serialization/reconstruction, interaction dispatch and undo; preserve the bounded object-raycast decision.
- Keep manipulation responsive without waiting for the server.
- Preserve work on failed imports, saves and conflicts; distinguish local recovery from confirmed server saving.
- PostgreSQL stores project and publication records. QR/copied links resolve the same persisted publication URL and access policy.
- Enforce access on the server, including asset bytes. Publications are immutable saved snapshots.
- Add dependencies only for demonstrated needs. Use Font Awesome Free for product icons, attribution, accessible names and keyboard access.

## Where the implementation lives

- [Editor UI, document store and persistence](https://github.com/Team-Meshworks/gam300/tree/dev/web/editor)
- [Graphics and translation](https://github.com/Team-Meshworks/gam300/tree/dev/web/editor/graphics)
- [Project types, validation, serialization and fixture](https://github.com/Team-Meshworks/gam300/tree/dev/web/shared/project)
- [Asset registry and tooling](https://github.com/Team-Meshworks/gam300/tree/dev/assets)
- [Browser checks](https://github.com/Team-Meshworks/gam300/tree/dev/web/tests)

[Getting started](/en/getting-started) · [Testing](/en/testing) · [Decisions](/en/team) · [Handbook](/en/home)

_Last reviewed: 2 October 2026 against published dev 8f05c07 and its tracked architecture. Future product boundaries remain planned; passing engineering checks do not establish asset distribution approval._
