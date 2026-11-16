import { combineAbortSignals } from "../../shared/network/abort-signals";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../../shared/project/project-limits";
import { invalid, isRecord, type ValidationResult } from "../../shared/project/validation-helpers";
import type { ProjectDocument } from "../../shared/project/project-types";

export type OpenedServerProject = Readonly<{
  accountId: string;
  revision: number;
  document: ProjectDocument;
  canEdit: boolean;
}>;

// Read a candidate without replacing the current draft or consulting unscoped local recovery
// The caller completes its current session's departure decision before installing this candidate
export async function readServerProject(
  projectId: string,
  accountId: string,
  assetKinds: ReadonlyMap<string, string>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ValidationResult<OpenedServerProject>> {
  // Reject malformed project identity before making any authenticated request
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId) ||
    !accountId.trim()
  ) {
    return invalid("session", "An authenticated account and project are required");
  }
  // Bound the entire read and let account changes cancel every request in the sequence
  const deadline = AbortSignal.timeout(15_000);
  const cancelled = combineAbortSignals([signal, deadline]);
  const options = {
    headers: { "X-Spatia-Account": accountId },
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: cancelled,
  } as const;
  try {
    // Recheck the cookie-backed account around the read to reject a switch during loading
    // The application must still abort this signal immediately on logout or account change
    const sameAccount = async () => {
      const response = await fetcher("/api/v1/auth/session", options);
      if (!response.ok) {
        return false;
      }
      const session: unknown = await response.json();
      return (
        isRecord(session) && session.userId === accountId && session.mustChangePassword === false
      );
    };
    if (cancelled.aborted || !(await sameAccount())) {
      return invalid("session", "Sign in with the original account before opening this project");
    }
    const response = await fetcher(`/api/v1/projects/${encodeURIComponent(projectId)}`, options);
    if (!response.ok) {
      return invalid("project", "Project could not be opened; the current draft was kept");
    }
    // Bound the envelope before parsing and validate the embedded document with the shared reader
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES + 4096) {
      return invalid("project", "Project response exceeds the supported size");
    }
    const body: unknown = JSON.parse(text);
    if (
      !isRecord(body) ||
      typeof body.projectId !== "string" ||
      body.projectId.toLowerCase() !== projectId.toLowerCase() ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 0 ||
      !isRecord(body.permissions) ||
      typeof body.permissions.canEdit !== "boolean"
    ) {
      return invalid("project", "Project response is invalid; the current draft was kept");
    }
    const document = deserializeProject(JSON.stringify(body.document), assetKinds);
    if (!document.ok) {
      return document;
    }
    if (document.value.projectId.toLowerCase() !== projectId.toLowerCase()) {
      return invalid("project", "Project response belongs to a different project");
    }
    // Recheck after parsing so an old response cannot cross into a newer account session
    if (!(await sameAccount()) || cancelled.aborted) {
      return invalid("session", "The account changed while opening this project");
    }
    return {
      ok: true,
      value: {
        accountId,
        revision: body.revision as number,
        document: document.value,
        canEdit: body.permissions.canEdit,
      },
    };
  } catch {
    // Network, cancellation and malformed responses leave the active editor unchanged
    return invalid("project", "Project could not be opened; the current draft was kept");
  }
}
