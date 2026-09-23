---
title: Project Overview and Milestones
description: Users, product scope, delivery targets and open decisions.
published: true
date: 2026-09-23T15:06:13.833Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:56:20.274Z
---

# Project overview

**Product:** Spatial Experience Builder (SEB)  
**Development team:** Meshworks / Team 32  
**Client company:** VThere (commissioned Meshworks to develop SEB)

We are building an approachable browser tool for school-age children and teenagers to create spatial exhibitions without programming or learning a professional game editor. Educators support projects, administrators manage access, and visitors explore published experiences.

## Intended experience

An author chooses a curated environment, places approved models, attaches text/images/media, adds understandable WHEN → DO rules, previews the experience and publishes a visitor link. For example: **WHEN a visitor enters a zone → DO play narration**. This is the intended product workflow, not a list of features already delivered.

Creation should feel playful, understandable and forgiving. Edits are reversible; failures preserve work. M1 demonstrates the technical foundations through a basic UI. The Figma prototype explores the intended design; each final frontend slice needs design review and working behavior.

## Scope

| Included in the planned product | Outside the current scope |
| --- | --- |
| Curated GLB environments and models | Arbitrary model uploads or mesh/material editing |
| Text, image, audio/video and navigation content | User scripts, general variables or a game-engine framework |
| A fixed WHEN → DO vocabulary and linked scenes | Multiplayer editing or public self-registration |
| Undo/redo, local recovery and PostgreSQL-backed saving | Billing, native apps, VR/WebXR or Gaussian splats |
| Preview, visitor publication and access control | Unconfirmed iPad authoring support |

The content target is approximately **2–4 environments, 20–30 assets and one Virtual Exhibition starter template**. This is a target; approved supply and distribution rights still need verification. Desktop/laptop authoring and responsive visitor viewing are the baseline.

## Delivery roadmap

| Milestone | Planned dates | Delivery target |
| --- | --- | --- |
| M1 | 31 Aug–4 Oct 2026 | Editor/data foundations, custom movement, undo, local recovery, representative content and automated evidence. Integrated loop target: 2 Oct. |
| M2 | 5 Oct–8 Nov 2026 | Core content/rule authoring, rotate/scale, two scenes, shared player, accounts and PostgreSQL saving/recovery. |
| M3 | 9–29 Nov 2026 | End-to-end MVP: zone narration, preview parity, publishing/link sharing, access enforcement and another-device viewing. Feature implementation cutoff: 22 Nov. |
| M4 | Starts 4 Jan 2027; end pending | Pilot readiness, contextual guidance, search/precision, remaining triggers and QR sharing. |
| M5 | Dates pending | Educator analytics and measured visitor performance improvements. |
| M6 | Dates pending | Final compatibility, recovery/release verification and handoff. |

**M3 delivers the MVP; M6 is final delivery.** Reserve 23–29 November for verification, defect fixes and demonstration. These dates are planning targets, not confirmed submission timestamps.

## Current implementation boundary

The inspected dev branch contains a React/TypeScript/Vite editor, direct Three.js rendering, asset placement and selection, custom translation, movement buttons, undo/redo and validated v1 project data. It has CI and separate development/production deployments.

The integrated save/reload loop, content/rule authoring, application accounts, application PostgreSQL integration, independent visitor build and publication flow are not established in this baseline. Wiki.js accounts and its database are separate infrastructure. Prototype assets and UI do not constitute partner design or distribution approval.

## Completion evidence

Use [Testing and milestone evidence](/en/testing) for demonstration steps and recorded results. Keep live task status and owners in [Jira](https://meshworkss.atlassian.net/jira/software/projects/SCRUM/boards/1). Completing one implementation part does not complete its parent task or milestone.

Open product/design/device decisions belong in [Team and decisions](/en/team). No assessment exemptions, instructor approvals or intended-user study results are assumed.

[Back to handbook](/en/home)

_Last reviewed: 23 September 2026. Planning baseline: team project overview and six-milestone roadmap. Code baseline: dev e5591d0._
