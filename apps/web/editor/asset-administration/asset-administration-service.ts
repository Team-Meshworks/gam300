import type {
  AssetAdministrationData,
  AssetAdministrationResult,
  AssetAdministrationService,
  AssetCandidate,
} from "./asset-administration";

// Keep all requests on the authenticated application origin; never send cookies to an upload URL
export function createAssetAdministrationService(actorId: string): AssetAdministrationService {
  async function request<T>(
    path: string,
    signal: AbortSignal,
    init?: RequestInit,
  ): Promise<AssetAdministrationResult<T>> {
    try {
      const headers = new Headers(init?.headers);
      headers.set("X-Spatia-Account", actorId);
      if (init?.method) {
        // Bind both token acquisition and the write to the account that opened this screen.
        const csrf = await fetch("/api/v1/auth/csrf", {
          credentials: "same-origin",
          headers: { "X-Spatia-Account": actorId },
          signal,
        });
        if (!csrf.ok) {
          return failure(csrf.status);
        }
        const token: unknown = await csrf.json();
        if (
          !token ||
          typeof token !== "object" ||
          !("requestToken" in token) ||
          typeof token.requestToken !== "string"
        ) {
          return {
            ok: false,
            kind: "unavailable",
            message: "Asset service returned an invalid security token",
          };
        }
        headers.set("X-CSRF-TOKEN", token.requestToken);
      }

      // Send the bounded write only after obtaining a token; reads use the same account-bound origin
      const response = await fetch(path, { ...init, credentials: "same-origin", headers, signal });
      if (!response.ok) {
        return failure(response.status);
      }
      // Treat confirmed responses as untrusted until their lifecycle fields pass validation
      const value: unknown = await response.json();

      // Check the HTTP boundary before a malformed record can enable destructive controls
      if (!(init?.method ? isCandidate(value) : isAdministrationData(value))) {
        return { ok: false, kind: "unavailable", message: "Asset service returned invalid data" };
      }
      return { ok: true, value: value as T };

      // Let cancellation reach the mounting screen while ordinary network failures preserve its draft
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return {
        ok: false,
        kind: "unavailable",
        message: "The change could not be confirmed. Reload before retrying",
      };
    }
  }

  // Translate server failures without claiming that an unacknowledged write succeeded
  function failure(status: number): AssetAdministrationResult<never> {
    return {
      ok: false,
      kind: status === 401 || status === 403 ? "denied" : status >= 500 ? "unavailable" : "invalid",
      message:
        status === 401 || status === 403
          ? "Access to asset administration was denied"
          : status === 503
            ? "Asset validation or removal is currently unavailable"
            : "The asset operation could not be confirmed. Reload and try again",
    };
  }

  // Encode identities and upload metadata separately from bytes; the server owns validation and approval
  const base = "/api/v1/admin/assets";
  return {
    load: (signal) => request<AssetAdministrationData>(base, signal),
    submit: ({ file, kind, category, review }, signal) => {
      const query = new URLSearchParams({ name: file.name, kind });
      if (category !== null) {
        query.set("category", category);
      }
      return request<AssetCandidate>(`${base}?${query}`, signal, {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "model/gltf-binary",
          "X-Spatia-Asset-Metadata": btoa(
            Array.from(new TextEncoder().encode(JSON.stringify(review)), (byte) =>
              String.fromCharCode(byte),
            ).join(""),
          ),
        },
      });
    },

    // Approval records the human decision; a successful upload never calls this automatically
    review: (id, input, signal) =>
      request<AssetCandidate>(`${base}/${encodeURIComponent(id)}/approve`, signal, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
      }),

    // Require the caller's explicit opt-in instead of inferring global removal from ordinary deletion
    changeAvailability: (id, action, signal, removeFromProjects = false) =>
      request<AssetCandidate>(`${base}/${encodeURIComponent(id)}/availability`, signal, {
        method: "POST",
        body: JSON.stringify({ action, removeFromProjects }),
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Validate records before the screen derives review and retirement controls from them
function isCandidate(value: unknown): value is AssetCandidate {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.kind === "model" || value.kind === "environment") &&
    (value.category === null || typeof value.category === "string") &&
    typeof value.status === "string" &&
    ["pending", "approved", "invalid", "unavailable"].includes(value.status) &&
    typeof value.hidden === "boolean" &&
    typeof value.deleted === "boolean" &&
    typeof value.removedFromProjects === "boolean" &&
    (value.sha256 === undefined ||
      (typeof value.sha256 === "string" && /^[0-9a-f]{64}$/i.test(value.sha256))) &&
    (value.inspectionUrl === undefined ||
      value.inspectionUrl === null ||
      (typeof value.inspectionUrl === "string" &&
        /^\/api\/v1\/admin\/assets\/[a-f0-9-]{36}\/bytes$/.test(value.inspectionUrl))) &&
    ["source", "license", "reviewNotes"].every(
      (field) =>
        value[field] === undefined || value[field] === null || typeof value[field] === "string",
    ) &&
    (value.thumbnail === null || typeof value.thumbnail === "string") &&
    strings(value.validation) &&
    strings(value.actions) &&
    value.actions.every((action) => ["hide", "show", "delete", "remove"].includes(action))
  );
}

// Accept only the bounded GLB policy supported by this screen; spaces never acquire model categories
function isAdministrationData(value: unknown): value is AssetAdministrationData {
  if (
    !record(value) ||
    !Array.isArray(value.assets) ||
    !value.assets.every(isCandidate) ||
    !record(value.policy)
  ) {
    return false;
  }
  const policy = value.policy;
  return (
    strings(policy.extensions) &&
    policy.extensions.every((extension) => extension === ".glb") &&
    typeof policy.maxBytes === "number" &&
    policy.maxBytes > 0 &&
    policy.maxBytes <= 20 * 1024 * 1024 &&
    typeof policy.canSubmit === "boolean" &&
    typeof policy.canForceRemove === "boolean" &&
    record(policy.categories) &&
    policy.categories.environment === null &&
    strings(policy.categories.model)
  );
}
