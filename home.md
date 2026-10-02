---
title: Spatial Experience Builder Handbook
description: Meshworks documentation for Spatial Experience Builder (SEB), commissioned by VThere.
published: true
date: 2026-10-02T14:44:25.979Z
tags: 
editor: markdown
dateCreated: 2026-09-23T13:54:24.758Z
---

# Welcome to Spatial Experience Builder

**Spatial Experience Builder (SEB)** is a browser creation tool commissioned by **VThere**, the client company, and developed by **Meshworks (Team 32)**. It helps school-age children and teenagers build spatial exhibitions from curated assets and understandable WHEN → DO rules, with educator support.

This wiki is the team's shared handbook. Start here to understand the project, run the current prototype and find delivery evidence.

## Start here

| I want to… | Go to |
| --- | --- |
| Understand our users, scope and milestones | [Project overview](/en/project) |
| Install, build and run the project | [Getting started](/en/getting-started) |
| Understand the software and data boundaries | [Technical design](/en/technical-design) |
| Deploy, inspect or roll back the application | [Deployment and VM](/en/deployment) |
| Try placement, movement, saving and recovery | [Using SEB](/en/user-guide) |
| Run checks and find M1 requirement, owner and evidence mappings | [Testing and milestone evidence](/en/testing) |
| Record decisions and meeting outcomes | [Team and decisions](/en/team) |
| Maintain the wiki and recover its content | [Wiki maintenance](/en/wiki-maintenance) |

## Project links

- [GitHub development source](https://github.com/Team-Meshworks/gam300/tree/dev) — current M1 code and setup; feature work integrates here.
- [Jira board](https://meshworkss.atlassian.net/jira/software/projects/SCRUM/boards/1) — live task ownership and status.
- [Figma workspace](https://www.figma.com/design/KEli2cl4XkhctZKw7MYNm8/TD-project_1?node-id=0-1) — design exploration; a link does not imply design approval.
- [Development demo](https://51.79.242.181:8443/) and [production demo](https://51.79.242.181/) — separate deployed builds; application login is separate from wiki login.
- [Verified M1 CI run](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555) and [development deployment](https://github.com/Team-Meshworks/gam300/actions/runs/36967665801) — evidence for dev commit 8f05c07 on 2 October.

## Current position

We are working toward **M1, ending 4 October 2026**. The verified development build has a basic editor, asset placement and selection, custom translation, undo/redo, validated project data, browser recovery and JSON Open/Save/Save As. A room creates a saveable project; browser recovery also restores valid editing history. The interface and sample content remain provisional.

The [M1 evidence page](/en/testing) connects all seven Fxx features, six Txx technical systems and eleven Rxx foundations to Jira work, current owners and supporting results. **SCRUM-99 is treated as complete per the project owner's instruction on 2 October**; the mapping records the live Jira status separately.

Accounts, PostgreSQL-backed saving, content/rules, a separate shared visitor build and publication/sharing remain later delivery work. Asset distribution approval and final design approval are separate from passing engineering checks. Completing an implementation part does not complete the whole milestone.

## Keeping this handbook useful

Update the relevant page when behavior changes. State the source branch or build, date, evidence and limitations. Keep executable configuration in Git and live task status in Jira; link to them here. Never put passwords, private keys or tokens in pages, attachments or screenshots.

The original imported [README](/en/README) and [deployment document](/en/docs/deployment) are historical references. Use the current handbook guides and linked dev source for onboarding.

_Last reviewed: 2 October 2026. Implementation baseline: dev 8f05c0719eb568d9522b2ab55166e4c46619c873. Milestone dates are planning targets._
