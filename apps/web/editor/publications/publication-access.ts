import { isId } from "../home/workspace-api";
import { isRecord } from "../../shared/project/validation-helpers";

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
    !("projectId" in value) ||
    !("publicationId" in value) ||
    !("audience" in value) ||
    !("viewerIds" in value) ||
    !("hidden" in value) ||
    !("revoked" in value) ||
    !("deleted" in value) ||
    !("archived" in value) ||
    !("canManage" in value) ||
    !isId(value.projectId) ||
    !isId(value.publicationId) ||
    value.projectId.toLowerCase() !== projectId.toLowerCase() ||
    value.publicationId.toLowerCase() !== publicationId.toLowerCase() ||
    (value.audience !== "Public" &&
      value.audience !== "Unlisted" &&
      value.audience !== "Authenticated") ||
    !Array.isArray(value.viewerIds) ||
    value.viewerIds.length > 100 ||
    !value.viewerIds.every(isId) ||
    new Set(value.viewerIds.map((id: string) => id.toLowerCase())).size !==
      value.viewerIds.length ||
    typeof value.hidden !== "boolean" ||
    typeof value.revoked !== "boolean" ||
    typeof value.deleted !== "boolean" ||
    typeof value.archived !== "boolean" ||
    typeof value.canManage !== "boolean"
  )
    return null;
  return {
    publicationId: value.publicationId,
    projectId: value.projectId,
    audience: value.audience,
    viewerIds: [...value.viewerIds],
    hidden: value.hidden,
    revoked: value.revoked,
    deleted: value.deleted,
    archived: value.archived,
    canManage: value.canManage,
  };
}
