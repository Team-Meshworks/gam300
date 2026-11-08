import { combineAbortSignals } from "../../shared/network/abort-signals";
import { isId, isRecord } from "./workspace-api";

export type StudentPublication = {
  publicationId: string;
  sourceRevision: number;
  createdAt: string;
  visitorUrl: string;
};

/** Read a current unlisted link only for the account that opened this project */
export async function readStudentPublication(
  projectId: string,
  actorId: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<StudentPublication | null> {
  if (!isId(projectId) || !isId(actorId))
    throw new Error("The project link could not be verified.");
  const options = {
    headers: { "X-Spatia-Account": actorId },
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? combineAbortSignals([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  } as const;
  const response = await request(`/api/v1/projects/${projectId}/publication-links`, options);
  if (!response.ok) throw new Error("The published link could not be loaded.");
  const body: unknown = await response.json();
  const current = await request("/api/v1/auth/session", options);
  const session: unknown = current.ok ? await current.json() : null;
  if (!isRecord(session) || session.userId !== actorId || session.mustChangePassword !== false)
    throw new Error("Your account changed. Reload this project.");
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
