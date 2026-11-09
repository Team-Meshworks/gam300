import { combineAbortSignals } from "../../shared/network/abort-signals";
import { createAccountClient } from "../accounts/account-client";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

export interface ProjectSummary {
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  archived: boolean;
  permissions: { canEdit: boolean; canManage: boolean; canPublish: boolean };
}
export type WriteResult =
  | { kind: "confirmed"; value: unknown }
  | { kind: "rejected"; message: string; code?: string }
  | { kind: "unknown" };

export function createWorkspaceClient(request: typeof fetch = fetch) {
  const accounts = createAccountClient(request);
  async function read(path: string, signal?: AbortSignal, actorId?: string): Promise<unknown> {
    if (actorId !== undefined && !isId(actorId))
      throw new Error("The account could not be verified.");
    const response = await request(path, {
      ...(actorId ? { headers: { "X-Spatia-Account": actorId } } : {}),
      credentials: "same-origin",
      cache: "no-store",
      signal: signal
        ? combineAbortSignals([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Your session or access changed. Sign in again before continuing."
          : "This information is unavailable for your account. Try refreshing.",
      );
    return response.json();
  }
  async function pages(path: string, signal?: AbortSignal, actorId?: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await read(
        `${path}${path.includes("?") ? "&" : "?"}limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal,
        actorId,
      );
      if (
        !isRecord(page) ||
        !Array.isArray(page.items) ||
        !(page.nextCursor === null || isId(page.nextCursor))
      )
        throw new Error("The list could not be verified.");
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("The list could not be completed.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function projects(archived: boolean, signal?: AbortSignal): Promise<ProjectSummary[]> {
    const rows = await pages(`/api/v1/projects?archived=${archived}`, signal);
    const ids = new Set<string>();
    return rows.map((row) => {
      if (
        !isRecord(row) ||
        !isId(row.projectId) ||
        ids.has(row.projectId) ||
        typeof row.title !== "string" ||
        !Number.isSafeInteger(row.revision) ||
        (row.revision as number) < 0 ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt)) ||
        typeof row.archived !== "boolean" ||
        row.archived !== archived ||
        !isRecord(row.permissions) ||
        ["canEdit", "canManage", "canPublish"].some(
          (key) => typeof (row.permissions as Record<string, unknown>)[key] !== "boolean",
        )
      )
        throw new Error("The project list could not be verified.");
      ids.add(row.projectId);
      return row as unknown as ProjectSummary;
    });
  }
  async function write(
    actorId: string,
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body?: object,
    problemMessages: Record<string, string> = {},
  ): Promise<WriteResult> {
    let sent = false;
    try {
      if ((await accounts.getSession())?.userId !== actorId)
        return { kind: "rejected", message: "The account changed. Reload before continuing." };
      const token = await read("/api/v1/auth/csrf");
      if (!isRecord(token) || typeof token.requestToken !== "string" || !token.requestToken)
        throw new Error("Missing request token");
      const current = await accounts.getSession();
      if (current?.userId !== actorId || current.mustChangePassword)
        return { kind: "rejected", message: "The account changed. Reload before continuing." };
      sent = true;
      const response = await request(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": token.requestToken,
          "X-Spatia-Account": actorId,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if ([400, 409, 422, 429].includes(response.status)) {
        const problem: unknown = await response.json().catch(() => null);
        const detail =
          isRecord(problem) && typeof problem.code === "string"
            ? problemMessages[problem.code]
            : undefined;
        return {
          kind: "rejected",
          ...(detail && isRecord(problem) && typeof problem.code === "string"
            ? { code: problem.code }
            : {}),
          message:
            detail ??
            (response.status === 409
              ? "The record changed or already exists. Refresh before trying again."
              : response.status === 429
                ? "Too many changes. Wait before trying again."
                : "The change was not accepted. Check the details and your permissions."),
        };
      }
      // Authentication can expire after a commit; a missing acknowledgement must not invite a duplicate.
      if (![200, 201, 204].includes(response.status)) return { kind: "unknown" };
      const value: unknown = response.status === 204 ? null : await response.json();
      if ((await accounts.getSession())?.userId !== actorId) return { kind: "unknown" };
      return { kind: "confirmed", value };
    } catch {
      return sent
        ? { kind: "unknown" }
        : {
            kind: "rejected",
            message: "The request could not be sent. Your entries are unchanged.",
          };
    }
  }
  return { read, pages, projects, write };
}

export function projectReceipt(
  value: unknown,
  original?: ProjectSummary,
  archived?: boolean,
): boolean {
  return (
    isRecord(value) &&
    isId(value.projectId) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.archived === "boolean" &&
    (archived === undefined
      ? value.revision === 0 && value.archived === false && value.projectId !== original?.projectId
      : value.projectId === original?.projectId &&
        value.revision === original.revision + 1 &&
        value.archived === archived)
  );
}
