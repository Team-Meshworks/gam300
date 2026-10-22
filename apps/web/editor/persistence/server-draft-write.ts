import { isRecord } from "../../shared/project/validation-helpers";

export type ServerDraftRequest = Readonly<{ projectId: string; body: string }>;
export type ServerDraftResult =
  | {
      kind: "saved";
      receipt: { projectId: string; clientMutationId: string; revision: number };
    }
  | { kind: "conflict" | "rejected" | "failed" };

// Only send to the editor's own API origin
// Keep the captured body unchanged when retrying an uncertain write
export async function writeServerDraft(
  request: ServerDraftRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ServerDraftResult> {
  try {
    // Cookies stay in the browser; the request token goes in the header required by SCRUM-66
    // Fetch a fresh token so login changes cannot leave an old one cached here
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (!csrf.ok) return { kind: "failed" };
    const token: unknown = await csrf.json();
    if (!isRecord(token) || typeof token.requestToken !== "string" || !token.requestToken)
      return { kind: "failed" };

    const response = await fetcher(`/api/projects/${encodeURIComponent(request.projectId)}`, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token.requestToken },
      body: request.body,
    });
    // Another save may have moved the revision forward
    // Hand the conflict back for a user choice; keep our local work intact
    if (response.status === 409) return { kind: "conflict" };
    // These requests need account, permission or document correction before another attempt
    if ([400, 401, 403, 404, 413, 422].includes(response.status)) return { kind: "rejected" };
    if (response.status !== 200) return { kind: "failed" };

    // HTTP success alone can't clear the editor's unsaved state
    // The progress tracker also needs to match this receipt to its pending mutation
    const receipt: unknown = await response.json();
    if (
      !isRecord(receipt) ||
      typeof receipt.projectId !== "string" ||
      typeof receipt.clientMutationId !== "string" ||
      typeof receipt.revision !== "number" ||
      !Number.isSafeInteger(receipt.revision) ||
      receipt.revision < 0
    )
      return { kind: "failed" };
    return {
      kind: "saved",
      receipt: {
        projectId: receipt.projectId,
        clientMutationId: receipt.clientMutationId,
        revision: receipt.revision,
      },
    };
  } catch {
    // A dropped response can follow a successful server write
    // Leave reconciliation to the caller; never claim the document was saved here
    return { kind: "failed" };
  }
}
