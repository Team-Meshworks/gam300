---
title: Technical Design
description: Current architecture, authored data and the planned editor/player/server boundaries.
published: true
date: 2026-09-23T14:21:49.644Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:59:57.495Z
---

# Technical design

This page separates the implementation inspected on **dev e5591d0** from the planned product architecture. Numerical limits and future API/schema details still require implementation and verification.

## Stack and status

| Area | Current implementation | Planned extension |
| --- | --- | --- |
| UI | React 19, TypeScript, Vite, native HTML/CSS | Radix UI where a complex accessible primitive is needed |
| 3D | Direct Three.js and GLB loading | Curated content library and measured asset budgets |
| Editing | Document store, commands/history, custom translation | Content/rules, rotate/scale and multi-scene authoring |
| Data | Validated v1 project reader/serializer and fixture | v2 content/rules, migration and server validation |
| Runtime | Editor/visitor camera mode prototype | Shared player used by preview and a separate visitor build |
| Backend | Not present in this baseline | ASP.NET Core Identity, EF Core/Npgsql and PostgreSQL |
| Delivery | Docker/Caddy, GitHub Actions, separate dev/prod VM deployments | Application accounts, persistence and publication |

## Data and editing flow

1. A UI action requests a domain command.
2. The document store validates and commits the authored change.
3. History records the reversible operation.
4. React controls and Three.js rendering project the resulting state.
5. Pointer previews and frame updates remain outside React; a completed drag commits once.

The authored document is authoritative. Do not serialize the Three.js scene graph or make React UI state a second project model. Selection is shared between viewport and object list.

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

The server/player/publication elements above are the planned architecture. Runtime camera, visibility, media and interaction state must never mutate the authored draft. Visitor delivery must exclude authoring code; the current camera-mode toggle alone does not meet that boundary.

## Project data

The v1 project contains a schema version, project identity/title and one authored scene. The scene references its environment, starting camera and ordered objects. Objects retain stable IDs, asset IDs and transforms.

Positions use metres. Rotations use normalized quaternions in x/y/z/w order. Scale components are finite and positive. References and numeric values must be validated at import and server boundaries; TypeScript types alone do not validate untrusted JSON.

A rejected load must preserve the existing document and undo history. A successful replacement resets incompatible history. The initial grid-only editor does not yet represent a complete loaded project.

## Required engineering boundaries

- Implement our own gizmo manipulation, domain serialization/reconstruction, interaction dispatch and undo. Do not replace them with TransformControls or a ready-made editor.
- Keep manipulation responsive without waiting for the server.
- Distinguish local recovery from confirmed server saving. Failed saves/imports/conflicts must preserve work.
- PostgreSQL stores project and publication records in the product; Wiki.js's database is unrelated.
- Publications are immutable saved snapshots with server-enforced access, including protected asset bytes. A future QR code contains the publication URL.
- Add dependencies for demonstrated needs. Use Font Awesome Free for product icons and retain attribution; accessible names and keyboard access remain required.

## Where the implementation lives

- [Editor UI and document store](https://github.com/Team-Meshworks/gam300/tree/dev/web/editor)
- [Graphics and translation](https://github.com/Team-Meshworks/gam300/tree/dev/web/editor/graphics)
- [Project types, validation, serialization and fixture](https://github.com/Team-Meshworks/gam300/tree/dev/web/shared/project)
- [Asset registry and tooling](https://github.com/Team-Meshworks/gam300/tree/dev/assets)
- [Browser checks](https://github.com/Team-Meshworks/gam300/tree/dev/web/tests)

[Testing](/en/testing) · [Decisions](/en/team) · [Handbook](/en/home)

_Last reviewed: 23 September 2026. Current code: dev e5591d0; future boundaries summarized from the team architecture handoff._
