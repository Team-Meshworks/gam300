import { createWorkspaceClient, isId, isRecord } from "./workspace-api";

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
  if (!isRecord(session) || session.userId !== actorId || session.mustChangePassword !== false)
    throw new Error("Your account changed. Reload this project.");
}

function parseLink(item: unknown): StudentPublication {
  if (
    !isRecord(item) ||
    !isId(item.publicationId) ||
    !Number.isSafeInteger(item.sourceRevision) ||
    (item.sourceRevision as number) < 0 ||
    typeof item.createdAt !== "string" ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    !(item.requiresSignIn === undefined || typeof item.requiresSignIn === "boolean") ||
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
  return item as StudentPublication;
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
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > 1)
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
    if (!isRecord(item) || !isId(item.projectId) || published.has(item.projectId))
      throw new Error("The published project could not be verified.");
    published.set(item.projectId, parseLink(item));
  }
  await verifyActor(actorId, client, signal);
  return published;
}
