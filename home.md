---
title: Spatial Experience Builder Handbook
description: Meshworks documentation for Spatial Experience Builder (SEB), commissioned by VThere.
published: true
date: 2026-09-23T15:04:57.382Z
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
| Install and run the project | [Getting started](/en/getting-started) |
| Understand the software and data boundaries | [Technical design](/en/technical-design) |
| Deploy, inspect or roll back the application | [Deployment and VM](/en/deployment) |
| Try the current editor | [Using SEB](/en/user-guide) |
| Find test commands and recorded results | [Testing and milestone evidence](/en/testing) |
| Record decisions and meeting outcomes | [Team and decisions](/en/team) |
| Maintain the wiki and recover its content | [Wiki maintenance](/en/wiki-maintenance) |

## Project links

- [GitHub repository](https://github.com/Team-Meshworks/gam300) — source code and pull requests.
- [Jira board](https://meshworkss.atlassian.net/jira/software/projects/SCRUM/boards/1) — live task ownership and status.
- [Figma workspace](https://www.figma.com/design/KEli2cl4XkhctZKw7MYNm8/TD-project_1?node-id=0-1) — design exploration; a link does not imply design approval.
- [Development demo](https://51.79.242.181:8443/) and [production demo](https://51.79.242.181/) — separate deployed builds; application login is separate from wiki login.
- [CI and deployment runs](https://github.com/Team-Meshworks/gam300/actions) — build and release evidence.

## Current position

We are working toward **M1, ending 4 October 2026**. The current development branch has a basic editor, object placement and selection, custom movement, undo/redo, project-data validation and automated checks. The interface is a prototype. Saving/recovery integration, approved representative assets and the complete assessment demonstration remain open.

Accounts, database-backed saving, content/rules and the separate shared visitor workflow are later delivery work. Do not treat planned features or completed implementation parts as completion of an entire milestone.

## Keeping this handbook useful

Update the relevant page when behavior changes. State the source branch or build, date, evidence and limitations. Keep executable configuration in Git and live task status in Jira; link to them here. Never put passwords, private keys or tokens in pages, attachments or screenshots.

The original imported [README](/en/README) and [deployment document](/en/docs/deployment) are retained for reference. The handbook pages above explain their current context.

_Last reviewed: 23 September 2026. Implementation baseline: dev commit e5591d0. Milestone dates are planning targets._
