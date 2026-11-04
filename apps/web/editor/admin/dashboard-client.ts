export interface DashboardProject {
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  archived: boolean;
  permissions: { canEdit: boolean; canManage: boolean; canPublish: boolean };
}
export interface ProjectPage {
  items: DashboardProject[];
  nextCursor: string | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function createDashboardClient(accountId: string, request: typeof fetch = fetch) {
  async function send(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await request(path, {
        ...init,
        headers: { ...init.headers, "X-Spatia-Account": accountId },
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        init.method
          ? "Creation could not be confirmed. Check the organisation list before trying again."
          : "The dashboard could not be reached. Please try again.",
      );
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? "Administrator access could not be verified. Sign in again."
            : response.status === 400
              ? "Check the organisation name and try again."
              : response.status === 429
                ? "Too many requests. Please wait before trying again."
                : "The request could not be completed. Please try again.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error("The dashboard returned an invalid response. Please reload.");
    }
  }
  return {
    async projects(
      limit = 3,
      cursor: string | null = null,
      archived = false,
    ): Promise<ProjectPage> {
      const query = new URLSearchParams({ limit: String(limit), archived: String(archived) });
      if (cursor) query.set("cursor", cursor);
      const page = await send(`/api/projects?${query}`);
      if (
        !record(page) ||
        !Array.isArray(page.items) ||
        (page.nextCursor !== null && !id(page.nextCursor))
      )
        throw new Error("The project list returned an invalid page.");
      for (const item of page.items) {
        if (
          !record(item) ||
          !id(item.projectId) ||
          typeof item.title !== "string" ||
          !Number.isSafeInteger(item.revision) ||
          (item.revision as number) < 0 ||
          typeof item.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(item.updatedAt)) ||
          typeof item.archived !== "boolean" ||
          !record(item.permissions) ||
          typeof item.permissions.canEdit !== "boolean" ||
          typeof item.permissions.canManage !== "boolean" ||
          typeof item.permissions.canPublish !== "boolean"
        )
          throw new Error("The project list returned invalid details.");
      }
      return page as unknown as ProjectPage;
    },
    async createOrganization(name: string): Promise<void> {
      const csrf = await send("/api/auth/csrf");
      if (!record(csrf) || typeof csrf.requestToken !== "string" || !csrf.requestToken)
        throw new Error("Your session could not be verified. Sign in again.");
      const result = await send("/api/admin/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (
        !record(result) ||
        !id(result.id) ||
        typeof result.name !== "string" ||
        result.isActive !== true
      )
        throw new Error(
          "Creation could not be confirmed. Check the organisation list before trying again.",
        );
    },
  };
}
