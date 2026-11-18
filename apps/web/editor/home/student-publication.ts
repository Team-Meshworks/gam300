import { createWorkspaceClient, isId } from "./workspace-api";
import { isRecord, readField } from "../../shared/project/validation-helpers";

export type StudentPublication = {
  publicationId: string;
  sourceRevision: number;
  createdAt: string;
  visitorUrl: string;
  requiresSignIn?: boolean;
};

async function verifyActor(
  actorId: string,
  client: ReturnType<typeof createWorkspaceClient>,
  signal?: AbortSignal,
) {
  const session = await client.read("/api/v1/auth/session", signal, actorId);
  if (
    !isRecord(session) ||
    readField(session, "userId") !== actorId ||
    readField(session, "mustChangePassword") !== false
  )
    throw new Error("Your account changed. Reload this project.");
}

function parseLink(item: unknown): StudentPublication {
  if (!isRecord(item)) throw new Error("The published link could not be verified.");
  const requiresSignIn = readField(item, "requiresSignIn");
  if (
    !("publicationId" in item) ||
    !("sourceRevision" in item) ||
    !("createdAt" in item) ||
    !("visitorUrl" in item) ||
    !isId(item.publicationId) ||
    typeof item.sourceRevision !== "number" ||
    !Number.isSafeInteger(item.sourceRevision) ||
    item.sourceRevision < 0 ||
    typeof item.createdAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !(requiresSignIn === undefined || typeof requiresSignIn === "boolean") ||
    typeof item.visitorUrl !== "string"
  )
    throw new Error("The published link could not be verified.");
  const url = new URL(item.visitorUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/p/${item.publicationId}`
  )
    throw new Error("The published link could not be verified.");
  return {
    ...item,
    publicationId: item.publicationId,
    sourceRevision: item.sourceRevision,
    createdAt: item.createdAt,
    visitorUrl: item.visitorUrl,
    ...(requiresSignIn === undefined ? {} : { requiresSignIn }),
  };
}

/** The project details view shares unlisted links only */
export async function readStudentPublication(
  projectId: string,
  actorId: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<StudentPublication | null> {
  if (!isId(projectId)) throw new Error("The project link could not be verified.");
  const client = createWorkspaceClient(request);
  const body = await client.read(
    `/api/v1/projects/${projectId}/publication-links`,
    signal,
    actorId,
  );
  if (!isRecord(body) || !("items" in body) || !Array.isArray(body.items) || body.items.length > 1)
    throw new Error("The published link could not be verified.");
  const publication = body.items.length ? parseLink(body.items[0]) : null;
  await verifyActor(actorId, client, signal);
  return publication;
}

export async function readDashboardPublications(
  actorId: string,
  signal: AbortSignal,
): Promise<Map<string, StudentPublication>> {
  const client = createWorkspaceClient();
  const items = await client.pages("/api/v1/projects/publication-links", signal, actorId);
  const published = new Map<string, StudentPublication>();
  for (const item of items) {
    if (
      !isRecord(item) ||
      !("projectId" in item) ||
      !isId(item.projectId) ||
      published.has(item.projectId)
    )
      throw new Error("The published project could not be verified.");
    published.set(item.projectId, parseLink(item));
  }
  await verifyActor(actorId, client, signal);
  return published;
}
