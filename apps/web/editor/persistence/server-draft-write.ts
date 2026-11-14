import { combineAbortSignals } from "../../shared/network/abort-signals";
import { isRecord } from "../../shared/project/validation-helpers";

// Time allowed for one network attempt; the edit debounce lives in server-autosave
const SAVE_REQUEST_TIMEOUT_MS = 15_000;

export type ServerDraftRequest = Readonly<{ projectId: string; body: string }>;
export type ServerDraftResult =
  | {
      kind: "saved";
      receipt: { projectId: string; clientMutationId: string; revision: number };
    }
  | { kind: "conflict" | "rejected" | "failed" | "invalid" };

// Only send to the editor's own API origin
// Keep the captured body unchanged when retrying an uncertain write
export async function writeServerDraft(
  request: ServerDraftRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  accountId?: string,
): Promise<ServerDraftResult> {
  if (signal.aborted) return { kind: "failed" };
  // Bound the whole token/save exchange so a stalled connection releases the save queue
  // A timeout still leaves the server outcome uncertain; retry the original mutation
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(), SAVE_REQUEST_TIMEOUT_MS);
  // Either leaving the account or reaching the deadline cancels both fetches
  const requestSignal = combineAbortSignals([signal, timeout.signal]);
  try {
    // Cookies stay in the browser; the request token goes in the header required by SCRUM-66
    // Fetch a fresh token so login changes cannot leave an old one cached here
    const csrf = await fetcher("/api/v1/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: requestSignal,
      ...(accountId ? { headers: { "X-Spatia-Account": accountId } } : {}),
    });
    if ([401, 403].includes(csrf.status)) return { kind: "rejected" };
    if (!csrf.ok) return { kind: "failed" };
    const token: unknown = await csrf.json();
    if (!isRecord(token) || typeof token.requestToken !== "string" || !token.requestToken)
      return { kind: "failed" };

    const response = await fetcher(`/api/v1/projects/${encodeURIComponent(request.projectId)}`, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: requestSignal,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": token.requestToken,
        // The API compares this captured identity with the request's validated cookie account
        ...(accountId ? { "X-Spatia-Account": accountId } : {}),
      },
      body: request.body,
    });
    // Another save may have moved the revision forward
    // Hand the conflict back for a user choice; keep our local work intact
    if (response.status === 409) return { kind: "conflict" };
    if (response.status === 422) {
      const problem: unknown = await response.json().catch(() => null);
      // This application result follows receipt lookup and precedes any write
      if (isRecord(problem) && problem.code === "invalid_document") return { kind: "invalid" };
    }
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
  } finally {
    clearTimeout(deadline);

    // Release fallback subscriptions when this request settles, keeping the project session active
    timeout.abort();
  }
}
