import { isId, isRecord } from "../home/workspace-api";

export type PublicationAccessState = Readonly<{
  publicationId: string;
  projectId: string;
  audience: "Public" | "Unlisted" | "Authenticated";
  viewerIds: readonly string[];
  hidden: boolean;
  revoked: boolean;
  deleted: boolean;
  archived: boolean;
  canManage: boolean;
}>;

export function parsePublicationReference(value: string): string | null {
  const input = value.trim();
  if (isId(input)) return input;
  try {
    const url = new URL(input);
    const match = /^\/p\/([^/]+)$/.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      !isId(match[1])
    )
      return null;
    return match[1];
  } catch {
    return null;
  }
}

export function publicationAccessState(
  value: unknown,
  projectId: string,
  publicationId: string,
): PublicationAccessState | null {
  if (
    !isRecord(value) ||
    !isId(value.projectId) ||
    !isId(value.publicationId) ||
    value.projectId.toLowerCase() !== projectId.toLowerCase() ||
    value.publicationId.toLowerCase() !== publicationId.toLowerCase() ||
    typeof value.audience !== "string" ||
    !["Public", "Unlisted", "Authenticated"].includes(value.audience) ||
    !Array.isArray(value.viewerIds) ||
    value.viewerIds.length > 100 ||
    !value.viewerIds.every(isId) ||
    new Set(value.viewerIds.map((id: string) => id.toLowerCase())).size !==
      value.viewerIds.length ||
    ["hidden", "revoked", "deleted", "archived", "canManage"].some(
      (key) => typeof value[key] !== "boolean",
    )
  )
    return null;
  return {
    publicationId: value.publicationId,
    projectId: value.projectId,
    audience: value.audience as PublicationAccessState["audience"],
    viewerIds: [...value.viewerIds],
    hidden: value.hidden as boolean,
    revoked: value.revoked as boolean,
    deleted: value.deleted as boolean,
    archived: value.archived as boolean,
    canManage: value.canManage as boolean,
  };
}
