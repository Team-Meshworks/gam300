---
title: Testing and Milestone Evidence
description: Repeatable checks, recorded deployment results and honest completion evidence.
published: true
date: 2026-10-02T15:44:45.950Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:16:49.367Z
---

# Testing and milestone evidence

**Reviewed 2 October 2026.** This page links the seven M1 features, six technical systems and eleven foundation requirements to Jira owners and supporting results. Technical instructions are in [Getting started](/en/getting-started), [Using Spatia](/en/user-guide) and [Technical design](/en/technical-design); ownership and progress below are a dated planning snapshot.

## Verified build evidence

The published development baseline is **8f05c0719eb568d9522b2ab55166e4c46619c873**. [PR #13](https://github.com/Team-Meshworks/gam300/pull/13) was approved by Lemonical and merged into dev on 2 October.

- **[CI 36964933555](https://github.com/Team-Meshworks/gam300/actions/runs/36964933555): success**, on that exact commit. Its inspected logs show 16 unit-test files and **173 passing tests**, plus passing editor, integration, recovery, history and packaged-deployment checks.
- **[Development deployment 36967665801](https://github.com/Team-Meshworks/gam300/actions/runs/36967665801): success**, using that tested development build. Check /version.txt before a new demo; dev and main can differ.
- The CI run's **checks-8f05c07…** artifact contains build-specific reports/screenshots (retention to 16 October); **release-8f05c07…** contains the release descriptor (retention to 31 December). Artifact retention is finite.

These are existing results inspected for this documentation update. No new application test run, production promotion, intended-user study or assessment approval is claimed.

| Suite in the verified CI | Observed coverage |
| --- | --- |
| Editor/browser | Placement, selection/room occlusion, movement/cancellation, project loading, Undo/Redo, keyboard use, resizing, retry and WebGL fallback |
| Integration | Visitor authoring isolation, camera restoration, zoomed gizmos, mode cancellation and focus cleanup |
| Recovery | Save/Save As, quiet backup, restored dirty state, Save/Don't Save/Cancel, failed switching, file permissions/conflicts, multi-tab protection and download fallback |
| History | Persisted Undo/Redo, stable IDs, empty-scene redo, branching, atomic rejection, damaged-history fallback and legacy drafts |
| Build/deployment | Type/lint/format and asset checks, packaged app/server policy, loading and placement/undo |

## Run checks

Use the scripts in [published package.json](https://github.com/Team-Meshworks/gam300/blob/dev/web/package.json). From web/:

~~~sh
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run build
~~~

Install Chromium once with **npx playwright install chromium** (Ubuntu: **npx playwright install --with-deps chromium**). Keep **npm run dev** running in another terminal, then run:

~~~sh
npm run test:browser
npm run test:integration
npm run test:recovery
npm run test:history
~~~

The browser suites accept an explicit server URL. For the local container, run **docker compose up --build --wait** from the repository root, then **npm run test:deployment -- http://localhost:8081/** from web/. Validate assets from the root with **node assets/tools/validate-assets.mjs**.

The [CI workflow](https://github.com/Team-Meshworks/gam300/blob/dev/.github/workflows/ci.yml) is the executable check contract. Follow it rather than scripts from an unpublished working branch.

## M1 feature mapping: F01–F07

Owners below come from the current owning Jira task. **Fadzly** means Muhammad Nur Fadzly BIN ZULKIFLI; **Zifeng** means zifeng lim; **Ming Jie** means Ming Jie SHI; **Dalton** means dalton koh. Foo Rui Qin is shown by the Jira display name. CI references mean the verified run above, with the stated coverage and limits.

| ID / user outcome | Jira Epic → owning task | Owner / task state | Supporting result |
| --- | --- | --- | --- |
| F01 — Place exhibits in an environment | [SCRUM-41](https://meshworkss.atlassian.net/browse/SCRUM-41) → [SCRUM-16](https://meshworkss.atlassian.net/browse/SCRUM-16) | Fadzly / Done | CI placement and project reopening; [core walkthrough](/en/user-guide) |
| F02 — Inspect different views | [SCRUM-38](https://meshworkss.atlassian.net/browse/SCRUM-38) → [SCRUM-9](https://meshworkss.atlassian.net/browse/SCRUM-9) | Zifeng / Done | CI navigation, visitor camera and camera restoration |
| F03 — Select an exhibit, including an obscured object | [SCRUM-38](https://meshworkss.atlassian.net/browse/SCRUM-38) → [SCRUM-9](https://meshworkss.atlassian.net/browse/SCRUM-9) | Zifeng / Done | CI scene/list selection and room occlusion |
| F04 — Constrained movement and cancellation | [SCRUM-39](https://meshworkss.atlassian.net/browse/SCRUM-39) → [SCRUM-14](https://meshworkss.atlassian.net/browse/SCRUM-14) | Ming Jie / Done | CI custom translation, cancellation and zoomed gizmos; current UI scope is translation |
| F05 — Undo/Redo placement or movement | [SCRUM-40](https://meshworkss.atlassian.net/browse/SCRUM-40) → [SCRUM-15](https://meshworkss.atlassian.net/browse/SCRUM-15) | Dalton / Done | CI reversible commands, stable IDs, history recovery and branching |
| F06 — Save locally and resume the layout | [SCRUM-44](https://meshworkss.atlassian.net/browse/SCRUM-44) → [SCRUM-31](https://meshworkss.atlassian.net/browse/SCRUM-31) | Foo Rui Qin / Done | CI quiet backup, reload, restored layout/history and dirty state |
| F07 — Safely export/import a project file | [SCRUM-44](https://meshworkss.atlassian.net/browse/SCRUM-44) → [SCRUM-31](https://meshworkss.atlassian.net/browse/SCRUM-31) | Foo Rui Qin / Done | CI Open/Save/Save As, invalid files, disk conflicts and download fallback |

## M1 technical mapping: T01–T06

These are rubric technical IDs, separate from local component references such as the editor-interface task T05.

| ID / system | Jira Epic → owning task | Owner / task state | Supporting result / limit |
| --- | --- | --- | --- |
| T01 — Validated project format and reconstruction | [SCRUM-37](https://meshworkss.atlassian.net/browse/SCRUM-37) → [SCRUM-5](https://meshworkss.atlassian.net/browse/SCRUM-5) | Foo Rui Qin / Done | CI validation/serialization and rejected-load preservation; [architecture](/en/technical-design) |
| T02 — Viewport and selection | [SCRUM-38](https://meshworkss.atlassian.net/browse/SCRUM-38) → [SCRUM-9](https://meshworkss.atlassian.net/browse/SCRUM-9) | Zifeng / Done | CI representative GLB loading, cameras and synchronized selection; device performance needs its own measurements |
| T03 — Custom constrained manipulation | [SCRUM-39](https://meshworkss.atlassian.net/browse/SCRUM-39) → [SCRUM-14](https://meshworkss.atlassian.net/browse/SCRUM-14) | Ming Jie / Done | CI translation commit/cancel and camera/zoom cases; no finished rotate/scale UI claimed |
| T04 — Reversible authored-state editing | [SCRUM-40](https://meshworkss.atlassian.net/browse/SCRUM-40) → [SCRUM-15](https://meshworkss.atlassian.net/browse/SCRUM-15) | Dalton / Done | CI one command per completed drag, Undo/Redo, stable IDs and branching |
| T05 — Local storage and recovery | [SCRUM-44](https://meshworkss.atlassian.net/browse/SCRUM-44) → [SCRUM-31](https://meshworkss.atlassian.net/browse/SCRUM-31) | Foo Rui Qin / Done | CI IndexedDB session/history and JSON transfer; PostgreSQL remains M2 work |
| T06 — Asset manifest and validation pipeline | [SCRUM-47](https://meshworkss.atlassian.net/browse/SCRUM-47) → [SCRUM-18](https://meshworkss.atlassian.net/browse/SCRUM-18) | Dalton / Done | CI metadata/GLB checks and [asset pipeline](https://github.com/Team-Meshworks/gam300/blob/dev/assets/README.md); distribution approval remains separate |

## M1 foundation mapping: R01–R11

Snapshot from live Jira on **2 October 2026**. **SCRUM-99 is treated as complete per instruction for this review**. Its live Jira status is still In Review, and SCRUM-111 still In Progress; this wiki update does not change those statuses. Epic owners and child-task owners are kept distinct.

| Requirement | Jira Epic / supporting tasks | Current owner | Recorded state / supporting result |
| --- | --- | --- | --- |
| R01 — Repository and workflow | [SCRUM-99](https://meshworkss.atlassian.net/browse/SCRUM-99); [110](https://meshworkss.atlassian.net/browse/SCRUM-110), [111](https://meshworkss.atlassian.net/browse/SCRUM-111) | Fadzly | Complete per instruction; Jira In Review. Approved PR #13, exact-commit CI/deployment and [PR workflow](/en/team) |
| R02 — Jira project and backlog | [SCRUM-100](https://meshworkss.atlassian.net/browse/SCRUM-100); [112](https://meshworkss.atlassian.net/browse/SCRUM-112) | Epic unassigned; 112 Fadzly | Done; live Jira and the preserved F/T mappings above |
| R03 — Architecture v0.1 | [SCRUM-101](https://meshworkss.atlassian.net/browse/SCRUM-101); [113](https://meshworkss.atlassian.net/browse/SCRUM-113) | Fadzly | Done; [published architecture](https://github.com/Team-Meshworks/gam300/blob/dev/docs/architecture.md) and component responsibility record on 113 |
| R04 — Automated build | [SCRUM-102](https://meshworkss.atlassian.net/browse/SCRUM-102); [76](https://meshworkss.atlassian.net/browse/SCRUM-76) | Fadzly | Done; verified CI image and retained release descriptor |
| R05 — Automated checks/tests | [SCRUM-103](https://meshworkss.atlassian.net/browse/SCRUM-103); [114](https://meshworkss.atlassian.net/browse/SCRUM-114) | Fadzly | Done; 173 unit tests and four browser suites plus packaged deployment checks |
| R06 — Reproducible setup | [SCRUM-104](https://meshworkss.atlassian.net/browse/SCRUM-104); [115](https://meshworkss.atlassian.net/browse/SCRUM-115), [116](https://meshworkss.atlassian.net/browse/SCRUM-116) | Epic unassigned; 115/116 Fadzly | Done; [setup](/en/getting-started), published Windows/Ubuntu evidence; macOS unverified |
| R07 — Working technical POC | [SCRUM-105](https://meshworkss.atlassian.net/browse/SCRUM-105); [117](https://meshworkss.atlassian.net/browse/SCRUM-117) | Fadzly | Done; integrated place–move–undo–save–reload checks and [walkthrough](/en/user-guide) |
| R08 — Basic error handling | [SCRUM-106](https://meshworkss.atlassian.net/browse/SCRUM-106); [118](https://meshworkss.atlassian.net/browse/SCRUM-118), [119](https://meshworkss.atlassian.net/browse/SCRUM-119) | Foo Rui Qin | Done; invalid import, failed assets/storage, conflict and cancellation checks |
| R09 — Product demonstration | [SCRUM-107](https://meshworkss.atlassian.net/browse/SCRUM-107); [120](https://meshworkss.atlassian.net/browse/SCRUM-120), [121](https://meshworkss.atlassian.net/browse/SCRUM-121) | Dalton | Done in Jira; rehearsal and video recorded complete. Link the accessible recording and its build/device record here |
| R10 — Project documentation | [SCRUM-108](https://meshworkss.atlassian.net/browse/SCRUM-108); [122](https://meshworkss.atlassian.net/browse/SCRUM-122) | Fadzly | Epic To Do; 122 In Progress. Current handbook, workflow, design and requirement mappings published; second-member core walkthrough record remains pending |
| R11 — Individual contribution evidence | [SCRUM-109](https://meshworkss.atlassian.net/browse/SCRUM-109); [123](https://meshworkss.atlassian.net/browse/SCRUM-123), [124](https://meshworkss.atlassian.net/browse/SCRUM-124) | Epic unassigned; 123/124 Fadzly | Shelved in Jira. Shelved is not a verified contribution record or instructor exemption |

## Remaining evidence and product limits

- Record another member following the current documented core workflow for **SCRUM-122**, with date, build, device/browser and actual result. A reviewer approval or an automated run does not establish that walkthrough.
- Add the accessible product-demonstration recording and rehearsal evidence linked from **SCRUM-120/121**. Jira reports Done; the recording itself was not reviewed for this wiki update.
- Keep asset rights/approved inventory, final design approval, intended-user findings and declared-device performance measurements tied to actual evidence.
- Accounts, PostgreSQL project/publication storage, rules, a separate visitor build and sharing remain later work. M1 browser recovery is local only.
- Host reboot recovery and a real failed-release rollback were not exercised by this documentation update; original evidence covered automatic rollback logic.

## Historical deployment records

The 23 September runbook recorded the results below. They are retained as history, not current deployment identifiers.

| Environment | Historical commit | CI | Deployment |
| --- | --- | --- | --- |
| Development | f4ca18e725fdffaa4fa3beb1d78a5bba8026febc | [35863197853](https://github.com/Team-Meshworks/gam300/actions/runs/35863197853) | [35865493351](https://github.com/Team-Meshworks/gam300/actions/runs/35865493351) |
| Production | 4f5fa8c98e2556419d23b38f334b017280429feb | [35864105358](https://github.com/Team-Meshworks/gam300/actions/runs/35864105358) | [35865630988](https://github.com/Team-Meshworks/gam300/actions/runs/35865630988) |

The historical [cross-branch guard check](https://github.com/Team-Meshworks/gam300/actions/runs/35865302138) rejected a development CI run supplied for production before VM deployment.

## Result template

~~~text
Date and tester:
Milestone / Jira issue / Fxx or Txx or Rxx:
Branch, commit and environment URL:
Browser, OS and device:
Command or exact reproduction steps:
Expected result:
Actual result: PASS / FAIL / BLOCKED
Evidence link or attachment:
Known limits and follow-up:
~~~

Keep failures and follow-up. Screenshots/recordings must identify their build and omit credentials. Link large recordings from approved shared storage. A passing part does not establish milestone completion or instructor approval.

[Source deployment runbook](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) · [Wiki maintenance](/en/wiki-maintenance) · [Handbook](/en/home)

_Last reviewed: 2 October 2026 against live Jira, published dev 8f05c07, approved PR #13 and its CI/deployment evidence. SCRUM-99 completion is the requested assumption. Other Jira states were preserved._
