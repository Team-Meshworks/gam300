import { isId, isRecord } from "./workspace-api";

export type StudentPublication = {
  publicationId: string;
  sourceRevision: number;
  createdAt: string;
  visitorUrl: string;
  requiresSignIn?: boolean;
};

function optionsFor(actorId: string, signal?: AbortSignal): RequestInit {
  if (!isId(actorId)) throw new Error("The account could not be verified.");
  return {
    headers: { "X-Spatia-Account": actorId },
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  };
}

async function verifyActor(actorId: string, request: typeof fetch, signal?: AbortSignal) {
  const current = await request("/api/v1/auth/session", optionsFor(actorId, signal));
  const session: unknown = current.ok ? await current.json() : null;
  if (!isRecord(session) || session.userId !== actorId || session.mustChangePassword !== false)
    throw new Error("Your account changed. Reload this project.");
}

async function readLink(
  projectId: string,
  actorId: string,
  request: typeof fetch,
  dashboard: boolean,
  signal?: AbortSignal,
): Promise<StudentPublication | null> {
  if (!isId(projectId)) throw new Error("The project link could not be verified.");
  const response = await request(
    `/api/v1/projects/${projectId}/publication-links${dashboard ? "?view=dashboard" : ""}`,
    optionsFor(actorId, signal),
  );
  if (!response.ok) throw new Error("The published link could not be loaded.");
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > 1)
    throw new Error("The published link could not be verified.");
  if (body.items.length === 0) return null;
  const item: unknown = body.items[0];
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
  const publication = await readLink(projectId, actorId, request, false, signal);
  await verifyActor(actorId, request, signal);
  return publication;
}

/** Resolve only visible projects, with bounded requests and one final account check */
export async function readDashboardPublications(
  projectIds: readonly string[],
  actorId: string,
  signal: AbortSignal,
): Promise<Map<string, StudentPublication>> {
  const published = new Map<string, StudentPublication>();
  for (let i = 0; i < projectIds.length; i += 4) {
    signal.throwIfAborted();
    await Promise.all(
      projectIds.slice(i, i + 4).map(async (id) => {
        const item = await readLink(id, actorId, fetch, true, signal);
        if (item) published.set(id, item);
      }),
    );
  }
  await verifyActor(actorId, fetch, signal);
  return published;
}
