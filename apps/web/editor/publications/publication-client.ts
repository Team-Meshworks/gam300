import { isId, isRecord } from "../home/workspace-api";

// These checks run only after the server looks up the publication ID for replay
const newEditionProblems = {
  revision_conflict:
    "The saved project has changed. Refresh and confirm the latest revision before publishing.",
  approval_required:
    "This class project needs approval for the current saved revision before it can be published.",
  publication_assets_unavailable: "The saved project's assets are not available for publication.",
  invalid_document: "The saved project is not valid for publication.",
  unsupported_publication_runtime: "This project cannot be published by the current runtime.",
};
export const publicationProblems = {
  ...newEditionProblems,
  publication_id_conflict:
    "This publication request conflicts with an existing one. Refresh before continuing.",
};

export function isDefinitivePublicationRejection(
  code: string | undefined,
  retry: boolean,
): boolean {
  return !retry || (code !== undefined && Object.hasOwn(newEditionProblems, code));
}

export interface PublicationRequest {
  publicationId: string;
  confirmedRevision: number;
  intent: { audience: string; viewerIds: string[] };
}
export interface PublicationAcknowledgement {
  publicationId: string;
  projectId: string;
  sourceRevision: number;
  createdAt: string;
  visitorUrl: string;
}

export function publicationAcknowledgement(
  value: unknown,
  projectId: string,
  request: PublicationRequest,
): PublicationAcknowledgement | null {
  if (
    !isRecord(value) ||
    !isId(value.publicationId) ||
    value.publicationId !== request.publicationId ||
    value.projectId !== projectId ||
    value.sourceRevision !== request.confirmedRevision ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.visitorUrl !== "string"
  )
    return null;
  try {
    const url = new URL(value.visitorUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/p/${request.publicationId}`
    )
      return null;
  } catch {
    return null;
  }
  return {
    publicationId: value.publicationId,
    projectId,
    sourceRevision: request.confirmedRevision,
    createdAt: value.createdAt,
    visitorUrl: value.visitorUrl,
  };
}
