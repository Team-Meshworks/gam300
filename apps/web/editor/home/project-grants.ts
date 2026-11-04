import { createAccountClient } from "../accounts/account-client";
import { createDirectoryClient, type ManagedAccount } from "../directory/directory-client";
import { createWorkspaceClient, isId, isRecord } from "./workspace-api";

export type ProjectGrantSnapshot = {
  projectId: string;
  organizationId: string;
  revision: number;
  archived: boolean;
  assignments: { userId: string; canEdit: boolean; canManage: boolean; canPublish: boolean }[];
};

export type ProjectGrantDraft = {
  managedByUserIds: string[];
  assignedCreatorIds: string[];
  canPublishUserIds: string[];
};

export function parseProjectGrants(value: unknown, projectId: string): ProjectGrantSnapshot {
  if (
    !isRecord(value) ||
    !isId(value.projectId) ||
    value.projectId !== projectId ||
    !isId(value.organizationId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.archived !== "boolean" ||
    !Array.isArray(value.assignments) ||
    value.assignments.some(
      (row) =>
        !isRecord(row) ||
        !isId(row.userId) ||
        typeof row.canEdit !== "boolean" ||
        typeof row.canManage !== "boolean" ||
        typeof row.canPublish !== "boolean",
    ) ||
    new Set(value.assignments.map((row: { userId: string }) => row.userId)).size !==
      value.assignments.length
  )
    throw new Error("The project's current access could not be verified.");
  return value as unknown as ProjectGrantSnapshot;
}

const unavailable = () =>
  new Error("This project's existing access cannot be edited here. No changes were made.");

export function projectGrantDraft(
  snapshot: ProjectGrantSnapshot,
  accounts: ManagedAccount[],
): ProjectGrantDraft {
  if (snapshot.archived) throw unavailable();
  const draft: ProjectGrantDraft = {
    managedByUserIds: [],
    assignedCreatorIds: [],
    canPublishUserIds: [],
  };
  for (const grant of snapshot.assignments) {
    const account = accounts.find((row) => row.userId === grant.userId);
    if (
      !account ||
      !account.isActive ||
      account.orgId !== snapshot.organizationId ||
      !grant.canEdit
    )
      throw unavailable();
    if (account.role === "Educator" && grant.canManage && grant.canPublish) {
      draft.managedByUserIds.push(grant.userId);
    } else if (account.role === "Creator" && !grant.canManage) {
      draft.assignedCreatorIds.push(grant.userId);
      if (grant.canPublish) draft.canPublishUserIds.push(grant.userId);
    } else throw unavailable();
  }
  return draft;
}

export function projectGrantReplacement(
  snapshot: ProjectGrantSnapshot,
  accounts: ManagedAccount[],
  draft: ProjectGrantDraft,
): ProjectGrantDraft & { expectedRevision: number } {
  // Refuse any replacement that would silently drop or upgrade unsupported stored grants
  projectGrantDraft(snapshot, accounts);
  const eligible = (userId: string, role: string) =>
    accounts.some(
      (row) =>
        row.userId === userId &&
        row.role === role &&
        row.isActive &&
        row.orgId === snapshot.organizationId,
    );
  if (
    Object.values(draft).some((ids) => ids.length > 100 || new Set(ids).size !== ids.length) ||
    draft.managedByUserIds.some((id) => !eligible(id, "Educator")) ||
    draft.assignedCreatorIds.some((id) => !eligible(id, "Creator")) ||
    draft.canPublishUserIds.some((id) => !draft.assignedCreatorIds.includes(id))
  )
    throw new Error("Choose up to 100 active accounts for each access type in this organisation.");
  return {
    expectedRevision: snapshot.revision,
    managedByUserIds: [...draft.managedByUserIds],
    assignedCreatorIds: [...draft.assignedCreatorIds],
    canPublishUserIds: [...draft.canPublishUserIds],
  };
}

export async function readProjectGrantEditor(
  projectId: string,
  actorId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<{ snapshot: ProjectGrantSnapshot; accounts: ManagedAccount[] }> {
  if (!isId(projectId) || !isId(actorId)) throw unavailable();
  const bound: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Spatia-Account", actorId);
    return request(input, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
  };
  const api = createWorkspaceClient(bound);
  const snapshot = parseProjectGrants(
    await api.read(`/api/projects/${encodeURIComponent(projectId)}/assignments`, signal),
    projectId,
  );
  const directory = createDirectoryClient(bound);
  const [accounts, organizations] = await Promise.all([
    directory.accounts(snapshot.organizationId),
    directory.organizations(),
  ]);
  if (
    new Set(accounts.map((row) => row.userId)).size !== accounts.length ||
    accounts.some((row) => row.orgId !== snapshot.organizationId)
  )
    throw new Error(
      "The project's account choices could not be verified. Reload access to try again.",
    );
  const session = await createAccountClient(bound).getSession();
  if (
    signal.aborted ||
    !session ||
    session.userId !== actorId ||
    session.mustChangePassword ||
    session.role !== "Administrator"
  )
    throw new Error("Your account changed. Sign in again before managing access.");
  if (!organizations.some((row) => row.id === snapshot.organizationId && row.isActive))
    throw new Error("Access cannot be changed while this organisation is inactive.");
  projectGrantDraft(snapshot, accounts);
  return { snapshot, accounts };
}
