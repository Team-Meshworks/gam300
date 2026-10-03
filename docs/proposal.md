# Spatia proposal

Spatia is a browser tool that lets school-age children and
teenagers arrange a virtual exhibition, attach information and define interactions
without writing code. Meshworks (Team 32) develops it for VThere.

## Source and scope

The supplied source is the **VThere x DigiPen — Detailed Student Brief** for this project.
This Markdown record summarizes that student brief. It is distinct from VThere's
commercial MVP brief. Sections 2, 4, 6, 7, 9, 10 and 14 provide the product,
architecture, acceptance and delivery requirements below.

The brief calls for an M3 MVP and final delivery at the end of Project 6. The team
roadmap stages some vocabulary, precision, QR and analytics work after M3. Those
staged scope decisions still need the relevant mentor/instructor confirmation.
The planning workbooks are proposed contracts until their approval is recorded.

## Problem and users

A student who knows an exhibition's subject should be able to build a space people
can explore without learning a game engine. Slides lose spatial context; commissioning
bespoke software removes creation from the student. Spatia provides curated environments,
placeable exhibits and a small interaction vocabulary between those alternatives.

The primary author is a teenager with no experience of 3D software and a limited
lesson period. Educators manage assigned projects. Administrators provision accounts
and approved content. Visitors follow a publication link on a laptop, phone or tablet.

## Product commitments

- A visual browser editor with an asset palette, scene list, inspector and custom
  move/rotate/scale gizmos. Edits support undo and redo.
- Curated GLB environments and models with thumbnails and clear content rights.
  The brief targets two to four environments, roughly 20–30 models and an exhibition
  starter template. M1 uses a smaller declared representative set.
- Content components for hotspots, text, images, audio, video and navigation points.
- Ordered WHEN → DO rules. The source vocabulary includes click, zone entry, scene
  start, elapsed time, gaze and panel close; actions show panels, play media, move the
  camera, change visibility, navigate scenes and open links.
- Multiple ordered scenes and saved viewpoints.
- Durable project saving, truthful save status and recovery from interrupted or
  conflicting operations. PostgreSQL integration is the team's M2 commitment.
- One shared player for preview and a separate visitor application. Published
  output contains no authoring capability and reproduces preview behavior.
- Persisted publication snapshots with public, unlisted or authenticated access,
  shareable links and later QR sharing. Analytics follow the MVP in the team plan.

Arbitrary model upload, format conversion, mesh/material editing, author scripts,
general variables/conditions, real-time collaborative editing, VR and Gaussian
splatting are outside this student implementation scope.

## Custom engineering

The team implements constrained gizmo manipulation, project serialization and
reconstruction, ordered interaction dispatch and reversible edit commands. Three.js
provides rendering, math and loaders. A ready-made editor or TransformControls cannot
replace those custom components.

Authored project data is authoritative. Editor controls, the 3D view and the player
consume that contract. Runtime actions operate on a player session and cannot edit
the author's draft. Access to stored projects, publications and protected assets is
enforced on the server.

## Milestone plan

| Milestone | Target                    | Demonstrable outcome                                                                                                                                                                          |
| --------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Through 4 October 2026    | Place, select, move, undo, save/reload and transfer a small environment-backed project through basic controls; repeatable builds and tests.                                                   |
| M2        | 5 October–8 November 2026 | Core content/rule/scene authoring, shared preview, accounts and PostgreSQL project saving. Approved frontend slices follow technical readiness.                                               |
| M3        | 9–29 November 2026        | Build a small exhibition, preview it, publish a persisted snapshot and explore it on another device. Implementation cutoff is 22 November; the remaining week verifies the MVP.               |
| M4–M6     | Second trimester          | Pilot refinement and guidance, remaining planned vocabulary/precision/search/QR, analytics/performance and final compatibility/handoff. M4 begins 4 January 2027; other dates await the team. |

The [M1 deliverables](deliverables.md) record ownership, status and Jira mapping.
[UI/UX exports](design/ui-ux/README.md) contain the design references; the PDD is pending.
[architecture](architecture.md) distinguishes current implementation from planned work.

## Acceptance and unresolved decisions

The integrated acceptance flow is place three exhibits, attach content and ordered
rules, undo an edit, save/reopen, preview, publish and open the same exhibition on
another device. Additional cases cover zone narration once per entry, bidirectional
two-scene navigation, deletion/undo restoring references, obscured-object selection,
autosave failure, account isolation and preview/visitor parity.

Record results against the actual commit and target device. A classroom pilot,
child-participant consent, final asset distribution rights, exact school-device
profile, original proposal approval and final IP/reuse arrangements remain decisions
requiring the appropriate participants. Existing working tests do not establish
those approvals.
