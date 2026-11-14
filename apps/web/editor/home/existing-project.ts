import { createAccountClient } from "../accounts/account-client";
import { createWorkspaceClient, isId, isRecord, type ProjectSummary } from "./workspace-api";

export type ExistingProject = {
  projectId: string;
  title: string;
  revision: number;
  archived: boolean;
};
export const historicalCreationKey = (actorId: string) =>
  `spatia:uncertain-project-creation:${actorId}`;

export async function clearHistoricalCreation(
  storage: Pick<Storage, "getItem" | "removeItem">,
  actorId: string,
  observed: string,
  verifyActor: () => Promise<void>,
) {
  if (observed !== "1") throw new Error("The earlier creation warning could not be verified.");
  const key = historicalCreationKey(actorId);
  return navigator.locks.request(key, async () => {
    await verifyActor();
    if (storage.getItem(key) !== observed) return false;
    storage.removeItem(key);
    if (storage.getItem(key) !== null)
      throw new Error("The browser could not clear the earlier creation warning.");
    return true;
  });
}

export function createExistingProjectClient(request: typeof fetch = fetch) {
  const api = createWorkspaceClient(request);
  const accounts = createAccountClient(request);
  async function check(actorId: string) {
    const session = await accounts.getSession();
    if (session?.userId !== actorId || session.mustChangePassword)
      throw new Error("The account changed. Reload before continuing.");
  }
  async function list(actorId: string): Promise<ProjectSummary[]> {
    await check(actorId);
    const rows = (
      await Promise.all([false, true].map((archived) => api.projects(archived, undefined, actorId)))
    ).flat();
    await check(actorId);
    if (new Set(rows.map((row) => row.projectId)).size !== rows.length)
      throw new Error("The project list changed. Refresh before choosing a project.");
    return rows;
  }
  async function read(
    actorId: string,
    projectId: string,
    manageable: boolean,
  ): Promise<ExistingProject> {
    if (!isId(projectId)) throw new Error("The project identifier could not be verified.");
    await check(actorId);
    const value = await api.read(`/api/v1/projects/${projectId}`, undefined, actorId);
    if (
      !isRecord(value) ||
      value.projectId !== projectId ||
      !isRecord(value.document) ||
      typeof value.document.title !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0
    )
      throw new Error("The selected project could not be verified.");
    const rows = manageable ? await api.projects(false, undefined, actorId) : await list(actorId);
    const current = rows.find((row) => row.projectId === projectId);
    await check(actorId);
    if (!current || (manageable && (current.archived || !current.permissions.canManage)))
      throw new Error("The selected project is no longer active and manageable for your account.");
    if (current.revision !== value.revision)
      throw new Error(
        "The selected project changed. Review its current revision before continuing.",
      );
    return {
      projectId,
      title: value.document.title,
      revision: Number(value.revision),
      archived: current.archived,
    };
  }
  async function confirm(actorId: string, reviewed: ExistingProject, manageable: boolean) {
    const current = await read(actorId, reviewed.projectId, manageable);
    if (
      current.revision !== reviewed.revision ||
      current.title !== reviewed.title ||
      current.archived !== reviewed.archived
    )
      throw new Error(
        "The project changed since review. Review its current revision before continuing.",
      );
    return current;
  }
  return { list, read, confirm, check };
}
