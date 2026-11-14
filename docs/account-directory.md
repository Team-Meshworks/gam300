# Account and organization directory

This describes the administrator account and organization directory, profile overrides and lifecycle API.

All routes require a fully authorized administrator. Responses are not cacheable. Mutations use the existing CSRF and account security protections. No response exposes credentials, password hashes or security stamps.

If the session reaches its absolute expiry during transaction commit, the response is 401. A lifecycle change already committed remains durable despite that response; after authenticating again, read the current state before deciding whether to retry.

## Directory reads

`GET /api/v1/admin/users` and `GET /api/v1/admin/organizations` return `{ items, nextCursor }`. `nextCursor` is the last returned UUID when another page exists, otherwise null. Results are ordered by ascending UUID. `cursor` resumes after that UUID; `limit` defaults to 20 and is between 1 and 100. Optional `q` is a literal case-insensitive substring of username or organization name respectively, with at most 256 characters; NUL is invalid. User lists additionally accept exact `role`, `orgId`, and `isActive` filters; organization lists accept `isActive`. Unknown, repeated or invalid query parameters are rejected.

`GET /api/v1/admin/users/{id}` and `GET /api/v1/admin/organizations/{id}` return a matching record or 404. User records contain `userId`, `displayName`, `userName`, `role`, `orgId`, `isActive`, and `mustChangePassword`; organization records contain `id`, `name`, and `isActive`. User `isActive` is independent of organization state. Legacy accounts without a person's name use their username as `displayName`. User `q` searches both username and person's name.

`GET /api/v1/admin/organizations/{id}/projects` returns `{ items, nextCursor }` containing `id`, `title`, and `status` for the organisation's projects. It accepts only `cursor` and `limit` (1–20, default 20). Titles come from validated documents; status is Draft or Archived. Publication and approval are not inferred from account state.

## Account creation and overrides

### Administrator entry flow

Successful administrator sign-in at `/login` opens `/admin/dashboard`, matching the [Admin – Dashboard Figma frame](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=226-15002). A required password change completes first. An existing authorized administrator session visiting `/login` also opens the dashboard. Other roles retain their existing login flow and cannot open the administrator dashboard.

The dashboard's **View Organisations** link opens the existing `/accounts` directory, where administrators select an organisation and create or view its accounts. **Add Organisations** uses the existing `POST /api/v1/admin/organizations` endpoint. The workspace's Spatia home link returns administrators to their dashboard. Both Vite and the deployed Caddy app serve the nested dashboard URL directly, including on refresh.

Project cards use `GET /api/v1/projects`, with pagination and current/archived filters in **View All Projects**. Details expose the current project metadata and an editor link when permitted. This API does not provide cover images, publication visibility or approval status; the dashboard displays placeholders and actual Draft/Archived states. The environment and physical asset library dialogs browse the existing asset catalogue and generate previews where an image is absent. Administrator-only Add links open upload dialogs that accept GLBs by drag-and-drop or file chooser. Files that pass technical validation become available immediately; invalid files remain private, and existing pending submissions can still be reviewed.

`npm run test:admin-dashboard` checks the browser flow with API fixtures; `AccountDirectoryBrowserTests` checks both normal and forced-password-change administrator login, dashboard organisation creation, and account creation/overrides against the real API and PostgreSQL.

### Account dialogs

The administrator `/accounts` workspace reuses the organisation directory and opens Account Creation or View Account Details overlays. Facilitator maps to `Educator`; Creator maps to `Creator`.

`POST /api/v1/admin/users` accepts optional `displayName` alongside `userName`, `initialPassword`, `role`, and `orgId`. Apply migration `AddAccountDisplayName` before deploying the updated API. Names are limited to 256 characters and passwords retain the existing 12–128 character policy. New accounts require a password change on first sign-in.

`PATCH /api/v1/admin/users/{id}` overrides only supplied fields: `displayName`, `userName`, `role`, and `newTemporaryPassword`. Changes commit together; validation failures and duplicate usernames roll back every override. A successful change invalidates old sessions. A password override requires a password change on sign-in. Credentials are never returned; the UI reveals only a newly entered password.

Role overrides support Creator ↔ Educator within the current organisation. Administrator promotion/demotion and transfers are rejected. Accounts with retained class membership or student assignment history return 409 `account_role_in_use`; names and credentials remain editable. The UI exposes reversible account enable/disable with confirmation.

## Lifecycle policy

`PATCH /api/v1/admin/users/{id}/active` and `PATCH /api/v1/admin/organizations/{id}/active` require a JSON Boolean `isActive`. Success, including a repeated current state, returns 204. Missing records return 404 with `account_not_found` or `organization_not_found`; the last-administrator safeguard returns 409 `last_administrator`, and an account concurrency conflict returns 409 `account_conflict`. These operations preserve role, membership, password, lockout and forced-password-change state.

An active-to-inactive account transition rotates its Identity security stamp in the same transaction as the state change. Enabling it does not restore the old stamp; old cookies remain invalid. A same-state request does not rotate the stamp. The last active administrator cannot be disabled. For this safeguard, an active administrator has `IsActive` set, the fixed administrator role and no organization membership; lockout and forced-password-change restrictions remain separate. Account lifecycle operations serialize their check and update with the same PostgreSQL `AspNetUserRoles` table lock used by bootstrap, so concurrent disables cannot remove the last active administrator.

Organization changes lock the organization row and change only its `IsActive` state. Members of an inactive organization cannot authenticate or access protected operations under the current account resolver. An otherwise valid cookie can become usable again after re-enabling if it was not rejected and cleared while the organization was inactive. Global administrators retain their existing management permissions. Existing authorization checks and project access rules continue to apply; these changes do not cancel already authorized in-flight work.

## Permanent organization deletion

In the administrator dashboard, choose **View Organisations**, open an organisation, and choose **Delete organisation**. The confirmation shows the current counts of accounts, classes, assignments, projects (including archived projects), submissions, review decisions, and published editions. The administrator must type the exact organisation name before confirming. Active, inactive, and empty organisations can be deleted.

`GET /api/v1/admin/organizations/{id}/deletion` returns `{ id, name, accounts, classes, assignments, projects, submissions, reviews, publications }`. `DELETE /api/v1/admin/organizations/{id}` accepts `{ "confirmationName": "Exact organisation name" }` and returns 204 after commit. Both routes require a current, unrestricted Administrator session; deletion additionally requires CSRF verification and the account-write rate limit. The browser binds requests to the administrator who opened the directory. A mismatched name returns 400 `organization_confirmation_required`; a missing organisation returns 404 `organization_not_found`.

Deletion is permanent and transactional. It removes member accounts and Identity records, memberships, classes, assignments, project drafts and save receipts, provenance, review evidence, publication snapshots, and their access policies. Deleted accounts lose session access. Platform administrators and the platform-wide asset library remain. Other organisations' content is preserved; stale access grants and named-viewer references to the removed accounts are cleared. Unexpected cross-organisation historical references cause a 409 `organization_delete_conflict` and roll back the entire deletion. The browser never automatically retries an uncertain deletion.

Apply migration `20261106140000_AddOrganizationDeletion` before running the updated server. Ordinary review and publication history remains immutable. Only the deletion transaction can remove evidence belonging to its selected organisation. Deleted publication UUIDs alone are retained in `retired_publication_ids`, with no content, account, or organisation data, so old publication URLs cannot be reused. The database also rejects concurrent attempts to reuse these IDs. Downgrading this migration is blocked after IDs have been retired.

`OrganizationDeletionTests` exercises the real API and PostgreSQL. `npm run test:organization-deletion` checks confirmation, cancellation, errors, pending requests, successful removal, and mobile layout in the browser.

Provisioning, password validation, authentication and sessions reuse the existing account services. Public signup, individual account deletion, transfers and arbitrary role management are outside this contract.

## CSV account creation

Account Creation accepts CSV uploads with an optional Account Type (or Role) column containing Creator or Facilitator. Missing or blank account types use the dropdown selection; invalid account types reject the upload. One upload may contain both account types. Include Name and DOB or Date of Birth headers; capitalization, spaces and punctuation are ignored. Comma, semicolon, tab and pipe separators, reordered columns, extra columns and Excel separator directives are accepted. Dates accept year-first or day-first numeric formats and written English month names; ambiguous numeric dates use day/month/year and years must have four digits. UTF-8, UTF-16 with a byte-order mark and Windows-1252 files are supported. Uploads contain 1–200 rows and are limited to 512 KB. Usernames combine the normalized name with `DDMMYYYY`; existing usernames are skipped and new accounts are imported. Dates of birth are used to generate usernames and are not stored separately.

Preparing a CSV generates temporary passwords in memory. Save changes submits one identified import and downloads credentials for the accounts the server confirms it created. Keep the file, then acknowledge the handoff. If the reply or download is lost, reopen the organization’s account list as the issuing administrator, choose the import and download its available credentials. This also works from a fresh browser profile. First sign-in requires a password change.

The directory uses `PUT /api/v1/admin/organizations/{orgId}/bulk-imports/{operationId}`. The accounts and receipt commit together. The legacy `POST /api/v1/admin/users/bulk` retains its original response and has no recoverable handoff. Only the issuer can retrieve the original temporary credentials, for up to 24 hours while the account and password remain eligible. Acknowledgement ends recovery immediately. The state inventory specifies replay, cancellation and expiry. [Bulk import transitions](state-machines.md#workspace-write-lifecycles).

## Bulk student deletion

In an organisation's account list, the Select accounts icon opens selection mode, replacing the tabs and Add Accounts with Select all, Cancel and Delete. Cancel clears the selection and restores the normal toolbar. Checkboxes and bulk controls are hidden outside this mode. Individual row actions remain available while selecting. Select all selects Creator accounts matching the current search and role tab. Successful bulk deletion returns to the normal list. Changing filters clears the selection. The confirmation shows the selected account count and retention consequences without listing names; facilitators are excluded. A batch supports up to 1000 accounts and uses one atomic request to `POST /api/v1/admin/organizations/{id}/students/delete`. The server verifies every selected account belongs to that organisation and has only the Creator role. Invalid selections or failed updates roll back the batch. Successful deletion revokes access while retaining usernames, authored projects and review history, matching individual deletion. Retrying the same selection is safe.
