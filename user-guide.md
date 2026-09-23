---
title: Using VThere
description: A short walkthrough of the current editor prototype and its limitations.
published: true
date: 2026-09-23T14:16:54.377Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:13:27.498Z
---

# Using VThere

This walkthrough describes the current **M1 editor prototype**, inspected on dev e5591d0. It does not describe the complete planned product. The current interface is provisional.

## Open the prototype

Open the [development demo](https://51.79.242.181:8443/) using the team application login, or follow [Getting started](/en/getting-started) to run it locally. Wait until the asset library and scene finish loading. Use **Retry** if the interface offers it after a load failure.

The demo's login is separate from your wiki account. Current assets are development content with distribution rights still under review.

## Five-minute walkthrough

1. **Add an object.** Click an available asset tile to place it at the centre, or drag the tile onto the ground grid. Keyboard users can focus the tile and press Enter. Dropping outside the scene or pressing Escape cancels placement.
2. **Select it.** Click the object in the scene or choose it from **In this scene**. The object list also helps select something obscured by other geometry.
3. **Move it.** Use the selected object's translation handles or its X/Y/Z movement buttons. Each movement button steps by **0.25 metres**; the selected position is displayed below.
4. **Undo and redo.** Use the header buttons. A completed translation drag is one undo operation. Check that undo returns the object to its previous position and redo restores the move.
5. **Explore the camera mode.** Choose **Enter Visitor** to try the current first-person camera and **Exit Visitor** to return. This camera toggle is a prototype, not the finished independently published visitor application.

## Camera controls

| Mode | Input | Action |
| --- | --- | --- |
| Editor | Left-drag | Orbit |
| Editor | Right-drag | Pan |
| Editor | Mouse wheel | Zoom |
| Visitor camera | W / A / S / D | Move |
| Visitor camera | Left mouse drag | Look around |
| Visitor camera | Shift | Sprint |
| Visitor camera | Space / Ctrl | Fly up / down |

## Local development sample

When running the Vite development server, **Open sample project** loads the shared v1 fixture with its room, two crates and starting camera. Replacing existing work requests confirmation and clears incompatible placement history. This control is omitted from built container deployments, including the hosted development demo.

## Saving and unavailable features

The inspected baseline keeps authoring changes in memory. **Not saved** means the work has not been persisted. Closing or refreshing can lose it; the leave-page warning is not a save mechanism.

The current dev UI does not expose a complete file-import/export or local-recovery workflow. Do not rely on implementation notes from another branch until those changes are integrated and verified here.

Content panels, WHEN → DO rule authoring, multiple scenes, accounts, database saving, publishing and QR sharing remain staged work. The [project roadmap](/en/project) shows their targets.

## Report a problem

Record the environment URL and /version.txt commit, browser/device, actions taken, expected result and actual result. Add a screenshot or short recording without credentials. Put the observed defect in Jira and link it from relevant [test evidence](/en/testing).

For build-specific screenshots, inspect the retained test artifacts on the corresponding [CI run](https://github.com/Team-Meshworks/gam300/actions). The configured checks produce editor.png and deployment.png; artifact availability depends on retention.

[Getting started](/en/getting-started) · [Handbook](/en/home)

_Last reviewed: 23 September 2026, against current App.tsx, package scripts and editor controls on dev e5591d0. No intended-user usability study is claimed._
