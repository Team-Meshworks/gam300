---
title: Testing and Milestone Evidence
description: Repeatable checks, recorded deployment results and honest completion evidence.
published: true
date: 2026-09-23T14:16:49.367Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:16:49.367Z
---

# Testing and milestone evidence

**A configured test is not a passing test, and a passing implementation part is not a completed milestone.** Record the build, environment, outcome and limitations for each result.

## Run checks

From web/, use the scripts in [package.json](https://github.com/Team-Meshworks/gam300/blob/dev/web/package.json):

~~~sh
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run build
~~~

For browser authoring checks, run npm run dev in another terminal, install Chromium once with npx playwright install chromium, then run npm run test:browser.

For the local container, run docker compose up --build --wait from the repository root, then from web/:

~~~sh
npm run test:deployment -- http://localhost:8081/
~~~

The [CI workflow](https://github.com/Team-Meshworks/gam300/blob/dev/.github/workflows/ci.yml) also checks asset integrity and deployment isolation/rollback logic. Follow its actual configuration rather than stale copied commands.

## Current editor demonstration

| Scenario | Expected evidence |
| --- | --- |
| Click, keyboard and drag placement | One object and one undo step; cancelled/outside drops add nothing |
| Selection from scene and object list | Both identify the same stable object |
| Move, undo and redo | Correct transforms restored; one completed drag is one command |
| Development sample load | Room, two crates and saved camera; replacement confirmation when necessary |
| Rejected project data | Error with existing document/history preserved |
| Asset failure or unavailable WebGL | Clear error and supported recovery/fallback |
| Narrow viewport and keyboard use | Usable layout, labels and focus |
| Complete save/reload loop | Still open integration work in the inspected baseline |

## Recorded application deployment results

These results come from the tracked runbook dated **23 September 2026**. They were not rerun solely for wiki setup.

| Environment | Recorded deployed commit | CI | Deployment |
| --- | --- | --- | --- |
| Development | f4ca18e725fdffaa4fa3beb1d78a5bba8026febc | [35863197853](https://github.com/Team-Meshworks/gam300/actions/runs/35863197853) | [35865493351](https://github.com/Team-Meshworks/gam300/actions/runs/35865493351) |
| Production | 4f5fa8c98e2556419d23b38f334b017280429feb | [35864105358](https://github.com/Team-Meshworks/gam300/actions/runs/35864105358) | [35865630988](https://github.com/Team-Meshworks/gam300/actions/runs/35865630988) |

The record reports Chromium checks over trusted HTTPS for loading, server policy, models/textures, placement and undo. A [cross-branch guard check](https://github.com/Team-Meshworks/gam300/actions/runs/35865302138) rejected a development CI run supplied for production before VM deployment.

These are historical build references. Check /version.txt before a new demonstration rather than assuming the current branch head is deployed. Test artifacts include build-specific screenshots while retained.

## Open evidence

- Full save/reload integration and the complete M1 representative testbed.
- Asset use/distribution confirmation and intended-user demonstrations.
- Application host reboot recovery and a real failed-release rollback; the original release record covered automated rollback logic only.
- Final design approval and observed usability findings.

Preserve the supplied M1 baseline of seven features and six deliverables. No instructor exemption or milestone completion is inferred from this page.

## Result template

~~~text
Date and tester:
Milestone / Jira issue:
Branch, commit and environment URL:
Browser, OS and device:
Command or exact reproduction steps:
Expected result:
Actual result: PASS / FAIL / BLOCKED
Evidence link or attachment:
Known limits and follow-up:
~~~

Keep failures and their follow-up. Distinguish automated evidence from human usability sessions. Screenshots and recordings must identify their build and omit credentials. Link large recordings from approved shared storage.

[Source deployment evidence](https://github.com/Team-Meshworks/gam300/blob/dev/docs/deployment.md) · [Wiki verification](/en/wiki-maintenance) · [Handbook](/en/home)

_Last reviewed: 23 September 2026, against dev e5591d0. No new application-suite pass or milestone completion is claimed for these documentation changes._
