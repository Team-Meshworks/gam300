# M2 workspace integration

The production `/home` route uses the existing account client and UI foundation. `/login`
links here after a verified sign-in or mandatory password change. Vite and the Caddy
entry route both serve it. It does not mount the local-only editor or its recovery store.

## Plan and blocker checks

1. Project home: session gating, authorised lists, search, duplicate and archive/reopen.
   Completed against the existing SCRUM-66/69 routes. Opening a server project and
   coordinating account/project changes with recovery still require SCRUM-67. A blank
   project also needs an approved environment catalogue; `ProjectDocumentService`
   currently accepts development sample assets only and rejects production assets.
2. Mount SCRUM-162 class/roster and assignment screens, retaining the existing exact-request
   retry protocol and device-local deadline conversion. Check the SCRUM-161 wire contracts
   before this part. Keep editor opening unavailable while SCRUM-67 is missing.
3. Check remaining SCRUM-126 administration needs, run the combined checks and record
   acceptance coverage and remaining dependencies. Commit each completed part locally.

Figma was read through the browser on 30 October 2026, as requested: M2 page `137:59552`,
creator home `226:14714` and assignment form `450:4686` in file `z6zgUEbttr46IgQeHBISLu`.
The shared shell supplies the existing Figma landmark and ambient SVGs. Project imagery,
review state and published editions are not fabricated from the design's example data.
The API does not currently supply those fields. No Figma connector calls were used.

The available Git refs were checked. A fresh fetch required interactive GitHub authentication
and was stopped. New remote work may exist beyond the local refs. This branch starts from
`d186723` on `feature/scrum-162-assignment-api-integration`; SCRUM-161 remains a separate
backend branch. No shared branch is merged or pushed by this work.

## Project behaviour

Lists follow server permissions and pagination; no authored document enters the home.
Lifecycle writes submit the displayed revision and fresh CSRF token, recheck the account
around token acquisition and verify the acknowledgement. An uncertain response never
automatically retries a mutation. The user must inspect the refreshed list before another
copy, because creation and duplication have no server idempotency key. Archived projects
can be reopened only when the server returns management permission.

The editor integration is deliberately unavailable: `local-drafts.ts` still uses the
shared `local` principal. Linking a server project to that editor would risk loading the
wrong draft. This branch does not implement SCRUM-67 or claim that requirement is complete.

Part 1 checks: production build and architecture check passed; six focused API tests passed.
The browser regression passed anonymous/forced-password gates, role controls, archive/reopen,
uncertain duplication, denied-list recovery, logout and layouts at 1440, 1024, 768 and 390px.
Browser API responses in this regression are contract fixtures, not a live backend.
