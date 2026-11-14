import { createBulkImport, ImportRejected, ImportRequestError } from "./bulk-import";
import type { NewAccount } from "./account-csv";

export interface ManagedAccount {
  userId: string;
  displayName: string;
  userName: string;
  role: "Creator" | "Educator" | "Administrator";
  orgId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
}
export interface ManagedOrganization {
  id: string;
  name: string;
  isActive: boolean;
  projectCount: number;
  facilitatorCount: number;
  creatorCount: number;
}
export interface OrganizationDeletion {
  id: string;
  name: string;
  accounts: number;
  classes: number;
  assignments: number;
  projects: number;
  submissions: number;
  reviews: number;
  publications: number;
}
export interface ManagedProject {
  id: string;
  title: string;
  status: string;
  isPublic: boolean;
}
export interface AccountChanges {
  displayName?: string;
  userName?: string;
  role?: "Creator" | "Educator";
  newTemporaryPassword?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function account(value: unknown): ManagedAccount {
  if (
    !record(value) ||
    !id(value.userId) ||
    typeof value.userName !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.isActive !== "boolean" ||
    typeof value.mustChangePassword !== "boolean" ||
    !["Creator", "Educator", "Administrator"].includes(String(value.role)) ||
    (value.role === "Administrator" ? value.orgId !== null : !id(value.orgId))
  )
    throw new Error("The account service returned an invalid account.");
  return value as unknown as ManagedAccount;
}
export class DirectoryWriteUnconfirmed extends Error {}

export function createDirectoryClient(request: typeof fetch = fetch, accountId?: string) {
  async function send(path: string, init: RequestInit = {}, timeout = 15000): Promise<unknown> {
    let response: Response;
    try {
      response = await request(path, {
        ...init,
        ...(accountId ? { headers: { ...init.headers, "X-Spatia-Account": accountId } } : {}),
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (cause) {
      if (init.method)
        throw new DirectoryWriteUnconfirmed(
          init.method === "DELETE"
            ? "Deletion could not be confirmed. Close this window and refresh the directory before trying again."
            : "The save could not be confirmed. Close this window and refresh the directory before trying again.",
          { cause },
        );
      throw new Error("The directory could not be reached. Please try again.", { cause });
    }
    if (!response.ok) {
      if (init.method && response.status >= 500)
        throw new DirectoryWriteUnconfirmed(
          "The save could not be confirmed. Refresh the directory.",
        );
      const problem: unknown = await response.json().catch(() => null);
      if (
        record(problem) &&
        typeof problem.code === "string" &&
        [
          "bulk_import_not_found",
          "bulk_import_abandoned",
          "bulk_import_committed",
          "bulk_import_conflict",
        ].includes(problem.code)
      )
        throw new ImportRequestError(problem.code);
      const messages: Record<string, string> = {
        organization_confirmation_required:
          "Enter the organisation name exactly as shown to confirm deletion.",
        organization_not_found:
          "This organisation no longer exists. Close this window and refresh the directory.",
        organization_delete_conflict:
          "Nothing was deleted. Records changed or are linked outside this organisation. Refresh the directory before trying again.",
        username_taken: "That username is already taken. Choose another username.",
        account_role_in_use:
          "This account has class or assignment history, so its account type cannot be changed.",
        organization_unavailable:
          "This organisation is inactive. Enable it before adding accounts.",
        account_delete_forbidden: "This account cannot be deleted from the organisation directory.",
        account_not_found:
          "This account is no longer available. Close this window and refresh the directory.",
        account_conflict:
          "This account changed. Close this window and refresh before trying again.",
        invalid_account_input: "Check the account details. Passwords need 12–128 characters.",
      };
      const message =
        response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? "Administrator access is required."
            : response.status === 429
              ? "Too many changes. Please wait before trying again."
              : (record(problem) && typeof problem.code === "string" && messages[problem.code]) ||
                "The directory request failed. Please try again.";
      if (
        init.method === "PUT" &&
        path.includes("/bulk-imports/") &&
        [400, 401, 403, 404, 413, 422, 429].includes(response.status)
      )
        throw new ImportRejected(message);
      throw new Error(message);
    }
    if (
      init.method === "POST" &&
      path.includes("/bulk-imports/") &&
      (path.endsWith("/acknowledge") || path.endsWith("/abandon")) &&
      response.status !== 204
    )
      throw new DirectoryWriteUnconfirmed(
        "The import confirmation could not be verified. Check the same receipt.",
      );
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (cause) {
      if (init.method)
        throw new DirectoryWriteUnconfirmed(
          "The directory returned an invalid response. Refresh before trying again.",
          { cause },
        );
      throw new Error("The directory returned an invalid response. Refresh before trying again.", {
        cause,
      });
    }
  }
  async function write(path: string, method: string, body: object, timeout = 15000) {
    let csrf: unknown;
    try {
      csrf = await send("/api/v1/auth/csrf");
      if (!record(csrf) || typeof csrf.requestToken !== "string" || !csrf.requestToken)
        throw new Error("Your session could not be verified. Sign in again.");
    } catch (cause) {
      if (method === "PUT" && path.includes("/bulk-imports/"))
        throw new ImportRejected(
          "The account import could not be sent. Check your session and try again.",
          { cause },
        );
      throw cause;
    }
    return send(
      path,
      {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
        body: JSON.stringify(body),
      },
      timeout,
    );
  }
  async function list<T>(path: string, parse: (value: unknown) => T, limit = 100): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const page = await send(`${path}${path.includes("?") ? "&" : "?"}${params}`);
      if (
        !record(page) ||
        !Array.isArray(page.items) ||
        (page.nextCursor !== null && !id(page.nextCursor))
      )
        throw new Error("The directory returned an invalid page.");
      items.push(...page.items.map(parse));
      cursor = page.nextCursor as string | null;
      if (cursor && seen.has(cursor))
        throw new Error("The directory could not finish loading. Please refresh.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  return {
    deletion: async (orgId: string): Promise<OrganizationDeletion> => {
      const value = await send(`/api/v1/admin/organizations/${encodeURIComponent(orgId)}/deletion`);
      if (
        !record(value) ||
        value.id !== orgId ||
        typeof value.name !== "string" ||
        !value.name ||
        ![
          "accounts",
          "classes",
          "assignments",
          "projects",
          "submissions",
          "reviews",
          "publications",
        ].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
      )
        throw new Error("The deletion details could not be verified. Refresh before trying again.");
      return value as unknown as OrganizationDeletion;
    },
    deleteOrganization: (orgId: string, confirmationName: string) =>
      write(`/api/v1/admin/organizations/${encodeURIComponent(orgId)}`, "DELETE", {
        confirmationName,
      }),
    organizations: async (query = "") => {
      if (query.length > 256 || query.includes("\0")) {
        throw new Error("Search names must contain up to 256 characters.");
      }
      const search = query.trim();
      return list(
        `/api/v1/admin/organizations${search ? `?q=${encodeURIComponent(search)}` : ""}`,
        (value): ManagedOrganization => {
          if (
            !record(value) ||
            !id(value.id) ||
            typeof value.name !== "string" ||
            typeof value.isActive !== "boolean" ||
            !["projectCount", "facilitatorCount", "creatorCount"].every(
              (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
            )
          )
            throw new Error("Invalid organisation details.");
          return value as unknown as ManagedOrganization;
        },
      );
    },
    accounts: (orgId: string) =>
      list(`/api/v1/admin/users?orgId=${encodeURIComponent(orgId)}`, account),
    projects: (orgId: string) =>
      list(
        `/api/v1/admin/organizations/${encodeURIComponent(orgId)}/projects`,
        (value): ManagedProject => {
          if (
            !record(value) ||
            !id(value.id) ||
            typeof value.title !== "string" ||
            typeof value.status !== "string" ||
            typeof value.isPublic !== "boolean"
          )
            throw new Error("Invalid project details.");
          return value as unknown as ManagedProject;
        },
        20,
      ),
    getAccount: async (userId: string) =>
      account(await send(`/api/v1/admin/users/${encodeURIComponent(userId)}`)),
    create: async (
      orgId: string,
      values: {
        displayName: string;
        userName: string;
        role: "Creator" | "Educator";
        initialPassword: string;
      },
    ) => account(await write("/api/v1/admin/users", "POST", { ...values, orgId })),
    bulkImport: (orgId: string) => createBulkImport(accountId ?? "", orgId, write, send),
    createBulk: async (orgId: string, values: NewAccount[]) => {
      const result = await write(
        "/api/v1/admin/users/bulk",
        "POST",
        values.map((value) => ({ ...value, orgId })),
        90000,
      );
      const unconfirmed = "Creation could not be verified. Refresh the directory before retrying.";
      if (!Array.isArray(result) || result.length > values.length)
        throw new DirectoryWriteUnconfirmed(unconfirmed);
      let accounts: ManagedAccount[];
      try {
        accounts = result.map(account);
      } catch (cause) {
        throw new DirectoryWriteUnconfirmed(unconfirmed, { cause });
      }
      const expected = new Map(values.map((value) => [value.userName, value]));
      if (
        new Set(accounts.map((value) => value.userId)).size !== accounts.length ||
        new Set(accounts.map((value) => value.userName)).size !== accounts.length ||
        accounts.some(
          (item) => item.orgId !== orgId || expected.get(item.userName)?.role !== item.role,
        )
      )
        throw new DirectoryWriteUnconfirmed(unconfirmed);
      return accounts;
    },
    update: async (userId: string, values: AccountChanges) =>
      account(await write(`/api/v1/admin/users/${encodeURIComponent(userId)}`, "PATCH", values)),
    hideStudents: (orgId: string, userIds: string[]) =>
      write(
        `/api/v1/admin/organizations/${encodeURIComponent(orgId)}/students/hide`,
        "POST",
        { userIds },
        90000,
      ),
    deleteStudents: (orgId: string, userIds: string[]) =>
      write(
        `/api/v1/admin/organizations/${encodeURIComponent(orgId)}/students/delete`,
        "POST",
        { userIds },
        90000,
      ),
    deleteAccount: (userId: string) =>
      write(`/api/v1/admin/users/${encodeURIComponent(userId)}`, "DELETE", {}),
    setOrganizationActive: (orgId: string, isActive: boolean) =>
      write(`/api/v1/admin/organizations/${encodeURIComponent(orgId)}/active`, "PATCH", {
        isActive,
      }),
    setActive: (userId: string, isActive: boolean) =>
      write(`/api/v1/admin/users/${encodeURIComponent(userId)}/active`, "PATCH", { isActive }),
  };
}
