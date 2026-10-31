# Account and organization directory

This describes the administrator account and organization directory and lifecycle API.

All routes require a fully authorized administrator. Responses are not cacheable. Mutations use the existing CSRF and account security protections. No response exposes credentials, password hashes or security stamps.

## Directory reads

`GET /api/admin/users` and `GET /api/admin/organizations` return `{ items, nextCursor }`. `nextCursor` is the last returned UUID when another page exists, otherwise null. Results are ordered by ascending UUID. `cursor` resumes after that UUID; `limit` defaults to 20 and is between 1 and 100. Optional `q` is a literal case-insensitive substring of username or organization name respectively, with at most 256 characters; NUL is invalid. User lists additionally accept exact `role`, `orgId`, and `isActive` filters; organization lists accept `isActive`. Unknown, repeated or invalid query parameters are rejected.

`GET /api/admin/users/{id}` and `GET /api/admin/organizations/{id}` return a matching record or 404. User records contain `userId`, `userName`, `role`, `orgId`, `isActive`, and `mustChangePassword`; organization records contain `id`, `name`, and `isActive`. User `isActive` is the stored account flag, independent of organization state. These are the existing provisioning response fields. Role and membership are fixed; this API does not transfer users, change roles or delete records.

## Lifecycle policy

`PATCH /api/admin/users/{id}/active` and `PATCH /api/admin/organizations/{id}/active` require a JSON Boolean `isActive`. Success, including a repeated current state, returns 204. Missing records return 404 with `account_not_found` or `organization_not_found`; the last-administrator safeguard returns 409 `last_administrator`, and an account concurrency conflict returns 409 `account_conflict`. These operations preserve role, membership, password, lockout and forced-password-change state.

An active-to-inactive account transition rotates its Identity security stamp in the same transaction as the state change. Enabling it does not restore the old stamp; old cookies remain invalid. A same-state request does not rotate the stamp. The last active administrator cannot be disabled. For this safeguard, an active administrator has `IsActive` set, the fixed administrator role and no organization membership; lockout and forced-password-change restrictions remain separate. Account lifecycle operations serialize their check and update with the same PostgreSQL `AspNetUserRoles` table lock used by bootstrap, so concurrent disables cannot remove the last active administrator.

Organization changes lock the organization row and change only its `IsActive` state. Members of an inactive organization cannot authenticate or access protected operations under the current account resolver. An otherwise valid cookie can become usable again after re-enabling if it was not rejected and cleared while the organization was inactive. Global administrators retain their existing management permissions. Existing authorization checks and project access rules continue to apply; these changes do not cancel already authorized in-flight work.

Provisioning, password resets, authentication and sessions remain with SCRUM-68/83; project access effects remain with SCRUM-69. SCRUM-171 owns directory screens and SCRUM-126 owns the shared shell and provisioning/reset forms. Public signup, destructive deletion, transfers and arbitrary role management are outside this contract.
