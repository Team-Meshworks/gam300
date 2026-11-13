import { assignmentDetails, type AssignmentDetails } from "../projects/assignment-api";
import { createDirectoryClient } from "../directory/directory-client";

export interface ProjectPublicationState {
  projectId: string;
  publicationCount: number;
  hiddenCount: number;
  publicCount: number;
  publishingBlocked?: boolean;
  removed?: boolean;
}

export interface DashboardProject {
  projectId: string;
  title: string;
  revision: number;
  updatedAt: string;
  archived: boolean;
  organizationName: string;
  isPublic: boolean;
  permissions: { canEdit: boolean; canManage: boolean; canPublish: boolean };
}
export interface DashboardAssignment {
  classId: string;
  className: string;
  details: AssignmentDetails;
}
export interface DashboardProjectDetails {
  organization: { id: string; name: string };
  assignments: DashboardAssignment[];
}
export interface ProjectPage {
  items: DashboardProject[];
  nextCursor: string | null;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function createDashboardClient(
  accountId: string,
  request: typeof fetch = fetch,
  moderationScope: "admin" | "facilitator" = "admin",
) {
  const moderationPrefix =
    moderationScope === "admin" ? "/api/v1/admin/projects" : "/api/v1/projects";
  async function send(path: string, init: RequestInit = {}, timeout = 15000): Promise<unknown> {
    let response: Response;
    try {
      response = await request(path, {
        ...init,
        headers: { ...init.headers, "X-Spatia-Account": accountId },
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new Error(
        init.method
          ? "The change could not be confirmed. Reload its current state before trying again."
          : "The dashboard could not be reached. Please try again.",
      );
    }
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? moderationScope === "facilitator"
              ? "Project management access could not be verified. Sign in again."
              : "Administrator access could not be verified. Sign in again."
            : response.status === 400
              ? "Check the organisation name and try again."
              : response.status === 429
                ? "Too many requests. Please wait before trying again."
                : "The request could not be completed. Please try again.",
      );
    }
    if (response.status === 204) {
      return null;
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
      if (moderationScope === "admin") query.set("published", "true");
      if (cursor) query.set("cursor", cursor);
      const page = await send(`/api/v1/projects?${query}`);
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
          typeof item.organizationName !== "string" ||
          !item.organizationName.trim() ||
          item.organizationName.length > 256 ||
          typeof item.isPublic !== "boolean" ||
          (item.archived && item.isPublic) ||
          !record(item.permissions) ||
          typeof item.permissions.canEdit !== "boolean" ||
          typeof item.permissions.canManage !== "boolean" ||
          typeof item.permissions.canPublish !== "boolean"
        )
          throw new Error("The project list returned invalid details.");
      }
      return page as unknown as ProjectPage;
    },
    async projectDetails(projectId: string): Promise<DashboardProjectDetails> {
      if (!id(projectId)) {
        throw new Error("The project organisation could not be verified.");
      }
      const [access, organizations] = await Promise.all([
        send(`/api/v1/projects/${encodeURIComponent(projectId)}/assignments`),
        createDirectoryClient(request, accountId).organizations(),
      ]);
      if (!record(access) || access.projectId !== projectId || !id(access.organizationId)) {
        throw new Error("The project organisation could not be verified.");
      }
      const organization = organizations.find((row) => row.id === access.organizationId);
      if (!organization) {
        throw new Error("The project organisation is unavailable.");
      }
      if (!Array.isArray(access.classAssignments)) {
        throw new Error("The project assignments could not be verified.");
      }
      const assignments: DashboardAssignment[] = [];
      for (const context of access.classAssignments) {
        if (
          !record(context) ||
          !id(context.classId) ||
          !id(context.assignmentId) ||
          typeof context.className !== "string"
        ) {
          throw new Error("The project assignments could not be verified.");
        }
        const details = assignmentDetails(
          await send(`/api/v1/classes/${context.classId}/assignments/${context.assignmentId}`),
        );
        if (
          details.assignmentId !== context.assignmentId ||
          !details.projects.every((row) => id(row.projectId) && id(row.studentId)) ||
          (details.sourceProjectId !== projectId &&
            !details.projects.some((row) => row.projectId === projectId))
        ) {
          throw new Error("The project assignments could not be verified.");
        }
        assignments.push({ classId: context.classId, className: context.className, details });
      }
      return { organization: { id: organization.id, name: organization.name }, assignments };
    },
    async publicationStates(
      projectIds: readonly string[],
    ): Promise<Record<string, ProjectPublicationState>> {
      const ids = [...new Set(projectIds.map((value) => value.toLowerCase()))];
      if (ids.some((value) => !id(value))) {
        throw new Error("The publication projects could not be verified.");
      }
      const states: Record<string, ProjectPublicationState> = {};

      // Bound each query while avoiding one request per student in a long class list
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const page = await send(
          `${moderationPrefix}/publication-moderation?${new URLSearchParams({ ids: batch.join(",") })}`,
        );
        if (!record(page) || !Array.isArray(page.items) || page.items.length !== batch.length) {
          throw new Error("Publication visibility could not be verified.");
        }
        for (const item of page.items) {
          if (
            !record(item) ||
            !id(item.projectId) ||
            !batch.includes(item.projectId.toLowerCase()) ||
            states[item.projectId.toLowerCase()] ||
            (item.publishingBlocked !== undefined && typeof item.publishingBlocked !== "boolean") ||
            (item.removed !== undefined && typeof item.removed !== "boolean") ||
            ![item.publicationCount, item.hiddenCount, item.publicCount].every(
              (count) => Number.isSafeInteger(count) && (count as number) >= 0,
            ) ||
            (item.hiddenCount as number) + (item.publicCount as number) >
              (item.publicationCount as number)
          ) {
            throw new Error("Publication visibility could not be verified.");
          }
          states[item.projectId.toLowerCase()] = item as unknown as ProjectPublicationState;
        }
      }
      return states;
    },
    async moderatePublications(
      projectId: string | readonly string[],
      action: "hide" | "show" | "delete",
    ): Promise<void> {
      const ids = typeof projectId === "string" ? [projectId] : projectId;
      if (ids.length < 1 || ids.length > 1000 || ids.some((value) => !id(value))) {
        throw new Error("The publication projects could not be verified.");
      }
      const csrf = await send("/api/v1/auth/csrf");
      if (!record(csrf) || typeof csrf.requestToken !== "string" || !csrf.requestToken) {
        throw new Error("Your session could not be verified. Sign in again.");
      }
      await send(
        typeof projectId === "string"
          ? `${moderationPrefix}/${encodeURIComponent(projectId)}/publication-moderation`
          : `${moderationPrefix}/publication-moderation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
          body: JSON.stringify(
            typeof projectId === "string" ? { action } : { projectIds: ids, action },
          ),
        },
        typeof projectId === "string" ? 15000 : 90000,
      );
    },
    async createOrganization(name: string): Promise<void> {
      const csrf = await send("/api/v1/auth/csrf");
      if (!record(csrf) || typeof csrf.requestToken !== "string" || !csrf.requestToken)
        throw new Error("Your session could not be verified. Sign in again.");
      const result = await send("/api/v1/admin/organizations", {
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
