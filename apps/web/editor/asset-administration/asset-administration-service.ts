import { combineAbortSignals } from "../../shared/network/abort-signals";
import type {
  AssetAdministrationData,
  AssetAdministrationResult,
  AssetAdministrationService,
  AssetCandidate,
} from "./asset-administration";

// Keep all requests on the authenticated application origin; never send cookies to an upload URL
export function createAssetAdministrationService(actorId: string): AssetAdministrationService {
  const recoveryKey = `spatia.asset-write:${actorId}`;
  const unknownWrite = {
    ok: false,
    kind: "unknown",
    message: "The change may have been applied. Check the asset list before trying again.",
  } as const;
  async function requestLocked<T>(
    path: string,
    signal: AbortSignal,
    init?: RequestInit,
    reconcile = true,
    removalAssetId?: string,
  ): Promise<AssetAdministrationResult<T>> {
    let writeSent = false;
    let marker: string | null = null;
    let pendingRemoval: { assetId: string; operationId: string } | null = null;
    try {
      if (reconcile) {
        try {
          marker = localStorage.getItem(recoveryKey);
        } catch (error) {
          if (init?.method) throw error;
        }
      }
      if (init?.method && marker !== null) return unknownWrite;
      if (marker !== null && !init?.method && !isOperationId(marker)) {
        const saved: unknown = JSON.parse(marker);
        if (
          !record(saved) ||
          typeof saved.assetId !== "string" ||
          !saved.assetId ||
          !isOperationId(saved.operationId)
        )
          return unknownWrite;
        pendingRemoval = { assetId: saved.assetId, operationId: saved.operationId };
      }
      const headers = new Headers(init?.headers);
      headers.set("X-Spatia-Account", actorId);
      if (init?.method || pendingRemoval) {
        // Bind both token acquisition and the write to the account that opened this screen.
        const csrf = await fetch("/api/v1/auth/csrf", {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "X-Spatia-Account": actorId },
          signal: combineAbortSignals([signal, AbortSignal.timeout(15_000)]),
        });
        if (!csrf.ok) {
          return failure(csrf.status);
        }
        const token: unknown = await csrf.json();
        if (
          !token ||
          typeof token !== "object" ||
          !("requestToken" in token) ||
          typeof token.requestToken !== "string" ||
          !token.requestToken
        ) {
          return {
            ok: false,
            kind: "unavailable",
            message: "Asset service returned an invalid security token",
          };
        }
        headers.set("X-CSRF-TOKEN", token.requestToken);
      }

      if (pendingRemoval) {
        headers.set("Content-Type", "application/json");
        const response = await fetch(
          `/api/v1/admin/assets/${encodeURIComponent(pendingRemoval.assetId)}/removals/${pendingRemoval.operationId}/reconcile`,
          {
            method: "POST",
            body: "{}",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers,
            signal,
          },
        );
        if (!response.ok) return failure(response.status);
        const receipt: unknown = await response.json();
        if (
          response.status !== 200 ||
          !record(receipt) ||
          receipt.assetId !== pendingRemoval.assetId ||
          receipt.operationId !== pendingRemoval.operationId ||
          (receipt.outcome !== "removed" && receipt.outcome !== "notApplied")
        )
          return unknownWrite;
      }

      // Send the bounded write only after obtaining a token; reads use the same account-bound origin
      if (init?.method) {
        signal.throwIfAborted();
        const operationId = crypto.randomUUID();
        if (removalAssetId !== undefined) {
          pendingRemoval = { assetId: removalAssetId, operationId };
          marker = JSON.stringify(pendingRemoval);
          path = `/api/v1/admin/assets/${encodeURIComponent(removalAssetId)}/removals/${operationId}`;
          init = { ...init, method: "PUT", body: "{}" };
        } else {
          marker = operationId;
        }
        localStorage.setItem(recoveryKey, marker);
        if (localStorage.getItem(recoveryKey) !== marker)
          throw new Error("Could not record asset write");
        writeSent = true;
      }
      const response = await fetch(path, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers,
        signal,
      });
      if (!response.ok) {
        if (writeSent && (response.status >= 500 || [401, 408].includes(response.status))) {
          const problem: unknown = await response.json().catch(() => null);
          if (
            !(
              response.status === 503 &&
              record(problem) &&
              problem.code === "asset_intake_unavailable"
            )
          ) {
            return unknownWrite;
          }
        }
        if (writeSent && localStorage.getItem(recoveryKey) === marker)
          localStorage.removeItem(recoveryKey);
        return failure(response.status);
      }
      // Treat confirmed responses as untrusted until their lifecycle fields pass validation
      const value: unknown = await response.json();

      // Check the HTTP boundary before a malformed record can enable destructive controls
      if (!(init?.method ? isCandidate(value) : isAdministrationData(value))) {
        return writeSent
          ? unknownWrite
          : { ok: false, kind: "unavailable", message: "Asset service returned invalid data" };
      }
      if (
        removalAssetId !== undefined &&
        (response.status !== 200 ||
          !isCandidate(value) ||
          value.id !== removalAssetId ||
          !value.removedFromProjects ||
          !value.hidden ||
          !value.deleted ||
          response.headers.get("X-Spatia-Operation-Id") !== pendingRemoval?.operationId)
      )
        return unknownWrite;
      signal.throwIfAborted();
      if (marker !== null && localStorage.getItem(recoveryKey) === marker)
        localStorage.removeItem(recoveryKey);
      return { ok: true, value: value as T };

      // Let cancellation reach the mounting screen while ordinary network failures preserve its draft
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      return writeSent
        ? unknownWrite
        : {
            ok: false,
            kind: "unavailable",
            message: "Asset service is unavailable. Please try again.",
          };
    }
  }

  async function request<T>(
    path: string,
    signal: AbortSignal,
    init?: RequestInit,
    removalAssetId?: string,
  ): Promise<AssetAdministrationResult<T>> {
    if (!navigator.locks && !init?.method) return requestLocked<T>(path, signal, init, false);
    if (!navigator.locks)
      return {
        ok: false,
        kind: "unavailable",
        message: "This browser cannot safely coordinate asset changes.",
      };
    return navigator.locks.request(recoveryKey, () =>
      requestLocked<T>(path, signal, init, true, removalAssetId),
    );
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

    // Download through the same captured account as the list and report failures inside the open dialog
    async download(id, signal) {
      try {
        const response = await fetch(`${base}/${encodeURIComponent(id)}/bytes`, {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "X-Spatia-Account": actorId },
          signal: combineAbortSignals([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) {
          return failure(response.status);
        }
        const file = await response.blob();
        if (file.size === 0 || file.size > 20 * 1024 * 1024) {
          return { ok: false, kind: "unavailable", message: "Asset file is unavailable" };
        }
        return { ok: true, value: file };
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        return { ok: false, kind: "unavailable", message: "Download failed. Please try again" };
      }
    },
    submit: ({ file, kind, category, review }, signal) => {
      const query = new URLSearchParams({ name: file.name, kind });
      if (category !== null) {
        query.set("category", category);
      }
      return request<AssetCandidate>(`${base}?${query}`, signal, {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": kind === "audio" ? "audio/mp4" : "model/gltf-binary",
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
      request<AssetCandidate>(
        `${base}/${encodeURIComponent(id)}/availability`,
        signal,
        {
          method: "POST",
          body: JSON.stringify({ action, removeFromProjects }),
          headers: { "Content-Type": "application/json" },
        },
        action === "remove" ? id : undefined,
      ),
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
    (value.kind === "model" || value.kind === "environment" || value.kind === "audio") &&
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

// Accept only the bounded GLB and M4A intake policy; spaces never acquire categories
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
    policy.extensions.every((extension) => extension === ".glb" || extension === ".m4a") &&
    typeof policy.maxBytes === "number" &&
    policy.maxBytes > 0 &&
    policy.maxBytes <= 20 * 1024 * 1024 &&
    typeof policy.canSubmit === "boolean" &&
    (policy.canSubmitByKind === undefined ||
      (record(policy.canSubmitByKind) &&
        Object.entries(policy.canSubmitByKind).every(
          ([kind, allowed]) =>
            ["model", "environment", "audio"].includes(kind) && typeof allowed === "boolean",
        ))) &&
    typeof policy.canForceRemove === "boolean" &&
    record(policy.categories) &&
    policy.categories.environment === null &&
    strings(policy.categories.model) &&
    (!policy.extensions.includes(".m4a") || strings(policy.categories.audio))
  );
}

function isOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
