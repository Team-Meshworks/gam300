# Account and organization directory

This describes the administrator account and organization directory, profile overrides and lifecycle API.

All routes require a fully authorized administrator. Responses are not cacheable. Mutations use the existing CSRF and account security protections. No response exposes credentials, password hashes or security stamps.

If the session reaches its absolute expiry during transaction commit, the response is 401. A lifecycle change already committed remains durable despite that response; after authenticating again, read the current state before deciding whether to retry.

## Directory reads

`GET /api/admin/users` and `GET /api/admin/organizations` return `{ items, nextCursor }`. `nextCursor` is the last returned UUID when another page exists, otherwise null. Results are ordered by ascending UUID. `cursor` resumes after that UUID; `limit` defaults to 20 and is between 1 and 100. Optional `q` is a literal case-insensitive substring of username or organization name respectively, with at most 256 characters; NUL is invalid. User lists additionally accept exact `role`, `orgId`, and `isActive` filters; organization lists accept `isActive`. Unknown, repeated or invalid query parameters are rejected.

`GET /api/admin/users/{id}` and `GET /api/admin/organizations/{id}` return a matching record or 404. User records contain `userId`, `displayName`, `userName`, `role`, `orgId`, `isActive`, and `mustChangePassword`; organization records contain `id`, `name`, and `isActive`. User `isActive` is independent of organization state. Legacy accounts without a person's name use their username as `displayName`. User `q` searches both username and person's name.

`GET /api/admin/organizations/{id}/projects` returns `{ items, nextCursor }` containing `id`, `title`, and `status` for the organisation's projects. It accepts only `cursor` and `limit` (1–20, default 20). Titles come from validated documents; status is Draft or Archived. Publication and approval are not inferred from account state.

## Account creation and overrides

The administrator `/accounts` workspace reuses the organisation directory and opens Account Creation or View Account Details overlays. Facilitator maps to `Educator`; Creator maps to `Creator`.

`POST /api/admin/users` accepts optional `displayName` alongside `userName`, `initialPassword`, `role`, and `orgId`. Apply migration `AddAccountDisplayName` before deploying the updated API. Names are limited to 256 characters and passwords retain the existing 12–128 character policy. New accounts require a password change on first sign-in.

`PATCH /api/admin/users/{id}` overrides only supplied fields: `displayName`, `userName`, `role`, and `newTemporaryPassword`. Changes commit together; validation failures and duplicate usernames roll back every override. A successful change invalidates old sessions. A password override requires a password change on sign-in. Credentials are never returned; the UI reveals only a newly entered password.

Role overrides support Creator ↔ Educator within the current organisation. Administrator promotion/demotion and transfers are rejected. Accounts with retained class membership or student assignment history return 409 `account_role_in_use`; names and credentials remain editable. The UI exposes reversible account enable/disable with confirmation.

## Lifecycle policy

`PATCH /api/admin/users/{id}/active` and `PATCH /api/admin/organizations/{id}/active` require a JSON Boolean `isActive`. Success, including a repeated current state, returns 204. Missing records return 404 with `account_not_found` or `organization_not_found`; the last-administrator safeguard returns 409 `last_administrator`, and an account concurrency conflict returns 409 `account_conflict`. These operations preserve role, membership, password, lockout and forced-password-change state.

An active-to-inactive account transition rotates its Identity security stamp in the same transaction as the state change. Enabling it does not restore the old stamp; old cookies remain invalid. A same-state request does not rotate the stamp. The last active administrator cannot be disabled. For this safeguard, an active administrator has `IsActive` set, the fixed administrator role and no organization membership; lockout and forced-password-change restrictions remain separate. Account lifecycle operations serialize their check and update with the same PostgreSQL `AspNetUserRoles` table lock used by bootstrap, so concurrent disables cannot remove the last active administrator.

Organization changes lock the organization row and change only its `IsActive` state. Members of an inactive organization cannot authenticate or access protected operations under the current account resolver. An otherwise valid cookie can become usable again after re-enabling if it was not rejected and cleared while the organization was inactive. Global administrators retain their existing management permissions. Existing authorization checks and project access rules continue to apply; these changes do not cancel already authorized in-flight work.

Provisioning, password validation, authentication and sessions reuse the existing account services. Public signup, destructive deletion, transfers and arbitrary role management are outside this contract.
