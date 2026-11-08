import { isId, isRecord } from "../home/workspace-api";

export interface PublicationRequest {
  publicationId: string;
  confirmedRevision: number;
  intent: { audience: string; viewerIds: string[]; teacherOverride?: boolean };
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
