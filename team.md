---
title: Team and Decisions
description: Working agreements, confirmed decisions, open questions and a meeting-note template.
published: true
date: 2026-09-23T14:21:47.901Z
tags: 
editor: markdown
dateCreated: 2026-09-23T14:21:44.459Z
---

# Team and decisions

**Meshworks / Team 32** develops the VThere Spatial Experience Builder. This page records shared working agreements and decisions; live task ownership and progress remain in [Jira](https://meshworkss.atlassian.net/jira/software/projects/SCRUM/boards/1).

## People and access

The shared **team32** wiki account has content-editing access. The existing administrator manages accounts and site settings. Add the actual team roster and contact details only when members agree; names and roles have not been invented for this page.

Since a shared account does not identify the person making an edit, include your name or initials in meeting notes, evidence records and important decision updates. Give the professor a separate reader account once their login email is confirmed.

## Working agreements

- Feature branches integrate into dev. Production releases go through a dev → main PR and the manual deployment workflow.
- Code and executable configuration live in Git. Jira holds current owners/status. Figma holds design exploration/review. The wiki explains how these fit together.
- Members choose work; preserve existing owners and progress. Local references such as T05 are not Jira keys.
- Complete and verify small implementation parts, then update evidence and remaining work. A finished part does not finish its parent task.
- Distinguish implemented behavior, approved decisions, proposals and blockers. Do not claim testing, approval or user research that did not happen.
- Review generated changes and record AI contributions when required by school/company policy.

## Adopted direction

| Decision | Reason / consequence |
| --- | --- |
| A playful, approachable creation tool for young authors | Use curated choices and plain language; avoid professional-editor complexity |
| React/TypeScript/Vite, direct Three.js, ASP.NET Core/Identity and PostgreSQL | Preserve the agreed stack; add dependencies only for demonstrated needs |
| Custom gizmos, domain serialization, interaction dispatch and undo | Keep the substantive authoring behavior within our implementation |
| Authored data is authoritative; edits use commands | Rendering/UI are projections; undo remains coherent |
| Preview and visitor share a player | Runtime cannot mutate the draft; visitor delivery excludes authoring code |
| PostgreSQL-backed project/publication storage | M1 local recovery is not the final persistence architecture |
| M3 MVP, M6 final handoff | Keep the six-milestone delivery plan; see [Roadmap](/en/project) |

## Decisions still requiring confirmation

| Question | What is needed |
| --- | --- |
| Exact author age bands and final interaction/visual design | Team/partner design review and recorded Figma approval |
| Minimum devices and supported browser versions | Declared test devices and measurements |
| Representative assets and distribution rights | Approved asset supply, licenses and attribution |
| Object-raycast primitive allowance | Resolve the bounded engineering/assessment decision |
| Final numeric limits and v2 schema/API details | Implementation validation and cross-component review |
| Remaining second-trimester milestone dates | Confirmed team calendar |
| Instructor exemptions or approvals | Explicit confirmation; none assumed |

## Meeting notes

Create a dated child page when a meeting actually takes place and link it below. No historical meetings or decisions are fabricated.

~~~text
Date / meeting title:
Attendees:
Purpose:
Discussion and evidence links:
Decisions made and reasons:
Open questions:
Actions: agreed owner, task link, target date
Next review:
~~~

## Update a decision

Record the date, decision, alternatives considered, reason, who agreed, affected pages/tasks and whether it replaces an earlier decision. Keep the original context when a decision changes.

[Project scope](/en/project) · [Technical design](/en/technical-design) · [Handbook](/en/home)

_Last reviewed: 23 September 2026. Summarized from the team handoff and current working agreements; pending items are explicitly unconfirmed._
