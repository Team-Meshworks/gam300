---
title: Using Spatial Experience Builder
description: A short walkthrough of the current editor prototype and its limitations.
published: true
date: 2026-10-02T14:48:30.642Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:13:27.498Z
---

# Using Spatial Experience Builder

This walkthrough describes the **M1 editor prototype** on published **dev 8f05c07**, reviewed on 2 October 2026. The interface and sample content are provisional.

## Open the prototype

Open the [development demo](https://51.79.242.181:8443/) using the team application login, or follow [Getting started](/en/getting-started) to run it locally. Wait until the asset library and scene finish loading. Use **Retry** when offered after a load failure.

Application login is separate from your wiki account. Asset distribution rights remain under review. For demonstrations, identify the build using /version.txt.

## Core walkthrough

1. **Choose a room.** Add **test-room** from the asset library to create a saveable project. Loose objects on the initial grid need a room before they can be saved as a project.
2. **Add an exhibit.** Click **test-crate**, press Enter on its focused tile, or drag it onto the ground grid. Dropping outside the scene or pressing Escape cancels placement.
3. **Select it.** Click the object in the scene or choose it from **In this scene**. The list lets you select something obscured by other geometry, including the room.
4. **Move it.** Use its custom translation handles or X/Y/Z movement buttons. A button steps by **0.25 metres**. Escape during a drag cancels the preview; a completed drag creates one undo operation.
5. **Undo and redo.** Use the header buttons. Undo restores the earlier layout; Redo restores the change.
6. **Save a project file.** Choose **Save** or **Save As** in the project menu. Keep the JSON file so you can reopen or transfer the project.
7. **Check recovery.** Make another edit, allow two seconds for the quiet browser backup, then reload. The scene and valid Undo/Redo history return. The JSON file can still be **Not saved** if those later edits were not written to it.
8. **Open the file.** Use **Open** and choose the saved JSON. If your current project has unsaved edits, **Save**, **Don't Save** or **Cancel** decides whether to replace it. A rejected file or failed save preserves the current work.

## Saving and recovery

| Action or state | Meaning |
| --- | --- |
| Quiet browser backup | Local recovery in this browser; it is separate from the JSON file and server saving |
| Saved / Not saved | Whether current authored work is confirmed written to the chosen JSON file |
| Save | Update the connected file, reconnect permission after reload when needed, and retry a failed browser backup |
| Save As | Choose a different project JSON file |
| File upload/download fallback | Open/transfer JSON in browsers without file pickers; downloads keep the file status unsaved because the browser provides no completion receipt |
| New / Open | Ask about unsaved work before replacing the scene; Cancel preserves it |
| File or multi-tab conflict | Preserve work and report the conflict rather than silently overwrite newer content |
| Damaged older recovery record | Ask before opening another readable backup and retain the rejected record |

Keep an exported JSON file for portable work. Browser recovery belongs to the current browser storage; it is not an account, cloud backup or PostgreSQL save.

## Camera controls

| Mode | Input | Action |
| --- | --- | --- |
| Editor | Left-drag away from handles | Orbit |
| Editor | Right-drag | Pan |
| Editor | Mouse wheel | Zoom |
| Visitor camera | W / A / S / D | Move |
| Visitor camera | Left mouse drag | Look around |
| Visitor camera | Shift | Sprint |
| Visitor camera | Space / Ctrl | Fly up / down |

Choose **Enter Visitor** to explore and **Exit Visitor** to return. Authoring controls and save shortcuts are inactive while visiting; movement stops when the window loses focus. This mode is part of the editor. The separate published visitor application remains planned.

## Development sample

**Open sample project** is available in the Vite development server and the hosted dev build. It loads the shared v1 fixture with its room, two crates and starting camera. Unsaved-work decisions apply when replacing a project. The main production build omits this control.

## Planned features

Content panels, WHEN → DO rules, multiple scenes, application accounts, PostgreSQL saving, publishing and QR sharing remain staged work. See the [project roadmap](/en/project). The current custom movement controls demonstrate translation; this guide does not claim a finished rotate/scale UI.

## Report a problem

Record the environment URL and /version.txt commit, browser/device, actions taken, expected result and actual result. Add a screenshot or short recording without credentials. Put the observed defect in Jira and link it from [test evidence](/en/testing).

Build-specific screenshots are in retained artifacts on the [verified CI run](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555). Availability depends on retention.

[Getting started](/en/getting-started) · [Testing and evidence](/en/testing) · [Handbook](/en/home)

_Last reviewed: 2 October 2026 against published dev 8f05c07, its README, architecture and passing CI logs. No intended-user usability study is claimed._
