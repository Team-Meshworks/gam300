import { createBulkImport, ImportRejected, ImportRequestError } from "./bulk-import";

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
const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function account(value: unknown): ManagedAccount {
  if (
    !isObject(value) ||
    !("userId" in value) ||
    !id(value.userId) ||
    !("userName" in value) ||
    typeof value.userName !== "string" ||
    !("displayName" in value) ||
    typeof value.displayName !== "string" ||
    !("isActive" in value) ||
    typeof value.isActive !== "boolean" ||
    !("mustChangePassword" in value) ||
    typeof value.mustChangePassword !== "boolean" ||
    !("role" in value) ||
    (value.role !== "Creator" && value.role !== "Educator" && value.role !== "Administrator") ||
    !("orgId" in value) ||
    (value.orgId !== null && !id(value.orgId)) ||
    (value.role === "Administrator") !== (value.orgId === null)
  )
    throw new Error("The account service returned an invalid account.");
  const { userId, userName, displayName, isActive, mustChangePassword, role, orgId } = value;
  return { userId, userName, displayName, isActive, mustChangePassword, role, orgId };
}
export class DirectoryWriteUnconfirmed extends Error {}

export function createDirectoryClient(request: typeof fetch = fetch, accountId?: string) {
  async function send(path: string, init: RequestInit = {}, timeout = 15000): Promise<unknown> {
    const deleting =
      init.method === "DELETE" || (init.method === "POST" && path.endsWith("/deletion"));
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
          deleting
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
      const code = isObject(problem) && "code" in problem ? problem.code : undefined;
      if (
        typeof code === "string" &&
        [
          "bulk_import_not_found",
          "bulk_import_abandoned",
          "bulk_import_committed",
          "bulk_import_conflict",
        ].includes(code)
      )
        throw new ImportRequestError(code);
      const messages = new Map(
        Object.entries({
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
          account_delete_forbidden:
            "This account cannot be deleted from the organisation directory.",
          account_not_found:
            "This account is no longer available. Close this window and refresh the directory.",
          account_conflict:
            "This account changed. Close this window and refresh before trying again.",
          invalid_account_input: "Check the account details. Passwords need 12–128 characters.",
        }),
      );
      const message =
        response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? "Administrator access is required."
            : response.status === 429
              ? "Too many changes. Please wait before trying again."
              : ((typeof code === "string" ? messages.get(code) : undefined) ??
                "The directory request failed. Please try again.");
      if (
        init.method === "PUT" &&
        path.includes("/bulk-imports/") &&
        [400, 403, 404, 413, 422, 429].includes(response.status)
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
    if (deleting && response.status !== 204)
      throw new DirectoryWriteUnconfirmed(
        "Deletion could not be confirmed. Refresh the directory before trying again.",
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
      if (
        !isObject(csrf) ||
        !("requestToken" in csrf) ||
        typeof csrf.requestToken !== "string" ||
        !csrf.requestToken
      )
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
        !isObject(page) ||
        !("items" in page) ||
        !Array.isArray(page.items) ||
        !("nextCursor" in page) ||
        (page.nextCursor !== null && !id(page.nextCursor))
      )
        throw new Error("The directory returned an invalid page.");
      items.push(...page.items.map(parse));
      cursor = page.nextCursor;
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
        !isObject(value) ||
        !("id" in value) ||
        value.id !== orgId ||
        !("name" in value) ||
        typeof value.name !== "string" ||
        !value.name ||
        !("accounts" in value) ||
        !isCount(value.accounts) ||
        !("classes" in value) ||
        !isCount(value.classes) ||
        !("assignments" in value) ||
        !isCount(value.assignments) ||
        !("projects" in value) ||
        !isCount(value.projects) ||
        !("submissions" in value) ||
        !isCount(value.submissions) ||
        !("reviews" in value) ||
        !isCount(value.reviews) ||
        !("publications" in value) ||
        !isCount(value.publications)
      )
        throw new Error("The deletion details could not be verified. Refresh before trying again.");
      const {
        id,
        name,
        accounts,
        classes,
        assignments,
        projects,
        submissions,
        reviews,
        publications,
      } = value;
      return {
        id,
        name,
        accounts,
        classes,
        assignments,
        projects,
        submissions,
        reviews,
        publications,
      };
    },
    deleteOrganization: (orgId: string, confirmationName: string) =>
      write(`/api/v1/admin/organizations/${encodeURIComponent(orgId)}/deletion`, "POST", {
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
            !isObject(value) ||
            !("id" in value) ||
            !id(value.id) ||
            !("name" in value) ||
            typeof value.name !== "string" ||
            !("isActive" in value) ||
            typeof value.isActive !== "boolean" ||
            !("projectCount" in value) ||
            !isCount(value.projectCount) ||
            !("facilitatorCount" in value) ||
            !isCount(value.facilitatorCount) ||
            !("creatorCount" in value) ||
            !isCount(value.creatorCount)
          )
            throw new Error("Invalid organisation details.");
          const { id: orgId, name, isActive, projectCount, facilitatorCount, creatorCount } = value;
          return { id: orgId, name, isActive, projectCount, facilitatorCount, creatorCount };
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
            !isObject(value) ||
            !("id" in value) ||
            !id(value.id) ||
            !("title" in value) ||
            typeof value.title !== "string" ||
            !("status" in value) ||
            typeof value.status !== "string" ||
            !("isPublic" in value) ||
            typeof value.isPublic !== "boolean"
          )
            throw new Error("Invalid project details.");
          const { id: projectId, title, status, isPublic } = value;
          return { id: projectId, title, status, isPublic };
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
    update: async (userId: string, values: AccountChanges) =>
      account(await write(`/api/v1/admin/users/${encodeURIComponent(userId)}`, "PATCH", values)),
    hideAccounts: (orgId: string, userIds: string[]) =>
      write(
        `/api/v1/admin/organizations/${encodeURIComponent(orgId)}/accounts/hide`,
        "POST",
        { userIds },
        90000,
      ),
    deleteAccounts: (orgId: string, userIds: string[]) =>
      write(
        `/api/v1/admin/organizations/${encodeURIComponent(orgId)}/accounts/delete`,
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
