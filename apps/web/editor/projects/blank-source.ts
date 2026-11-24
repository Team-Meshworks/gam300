import { assignmentSession } from "./assignment-api";
import type { EncodedProjectImage } from "./project-image";
import {
  createWorkspaceClient,
  isId,
  projectReceipt,
  type WriteResult,
} from "../home/workspace-api";
import { isRecord, readField } from "../../shared/project/validation-helpers";

import {
  acknowledgeCreation,
  loadCreationHead,
  type ReadCreationHead,
} from "../home/create-operation";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Write = (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>;
type ReadSource = (
  actorId: string,
  projectId: string,
) => Promise<{ kind: "available"; revision: number } | { kind: "unavailable" } | { kind: "retry" }>;
export async function readBlankSource(
  actorId: string,
  projectId: string,
  request: typeof fetch = fetch,
): ReturnType<ReadSource> {
  try {
    const before = await assignmentSession(undefined, request);
    if (before.userId !== actorId || before.mustChangePassword) return { kind: "retry" };
    const projects = await createWorkspaceClient(request).projects(false, undefined, actorId);
    const after = await assignmentSession(undefined, request);
    if (after.userId !== actorId || after.mustChangePassword) return { kind: "retry" };
    const current = projects.find(
      (project) => project.projectId.toLowerCase() === projectId.toLowerCase(),
    );
    return current?.permissions.canManage
      ? { kind: "available", revision: current.revision }
      : { kind: "unavailable" };
  } catch {
    return { kind: "retry" };
  }
}

export const blankSourceKey = (actorId: string) => `spatia.assignment.source:${actorId}`;

// The old attemptId was local-only and cannot identify a server creation.
export function historicalBlankSource(stored: string): boolean {
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return false;
    if (
      ["operationId", "creationGuard", "actorId", "adopted", "selectedExisting"].some(
        (field) => readField(value, field) !== undefined,
      )
    )
      return false;
    const imageKey = readField(value, "imageKey");
    return (
      blankSourceProject(stored) !== null ||
      (isId(readField(value, "attemptId")) &&
        typeof readField(value, "title") === "string" &&
        typeof readField(value, "environmentAssetId") === "string" &&
        (imageKey === undefined || typeof imageKey === "string"))
    );
  } catch {
    return false;
  }
}

export const uncorrelatedBlankSource = (stored: string) =>
  historicalBlankSource(stored) && blankSourceProject(stored) === null;

export function selectedExistingSource(stored: string, actorId: string) {
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value) || readField(value, "actorId") !== actorId) return null;
    if (
      ["operationId", "receipt", "adopted", "attemptId", "creationGuard"].some(
        (field) => readField(value, field) !== undefined,
      )
    )
      return null;
    const selection = readField(value, "selectedExisting");
    if (!isRecord(selection)) return null;
    const projectId = readField(selection, "projectId");
    const title = readField(selection, "title");
    const revision = readField(selection, "revision");
    if (
      !isId(projectId) ||
      typeof title !== "string" ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return null;
    return { projectId, title, revision };
  } catch {
    return null;
  }
}

export async function selectExistingSource(
  storage: Store,
  actorId: string,
  observed: string | null,
  source: { projectId: string; title: string; revision: number },
  verifyActor: () => Promise<void>,
) {
  if (
    !isId(source.projectId) ||
    typeof source.title !== "string" ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0
  )
    throw new Error("The selected source could not be verified.");
  const key = blankSourceKey(actorId);
  return navigator.locks.request(key, async () => {
    await verifyActor();
    if (storage.getItem(key) !== observed)
      throw new Error("The saved source changed in another tab. Reload and review recovery again.");
    if (
      observed !== null &&
      !historicalBlankSource(observed) &&
      selectedExistingSource(observed, actorId) === null
    )
      throw new Error(
        "Resolve the existing saved source operation before selecting another project.",
      );
    if (observed !== null && historicalBlankSource(observed)) {
      const known = blankSourceProject(observed);
      if (known && known.projectId !== source.projectId)
        throw new Error(
          "The earlier receipt identifies a different project. Resolve that saved source before choosing another.",
        );
    }
    const record = JSON.stringify({
      actorId,
      selectedExisting: {
        projectId: source.projectId,
        title: source.title,
        revision: source.revision,
      },
    });
    try {
      storage.setItem(key, record);
      if (storage.getItem(key) !== record) throw new Error("Storage unavailable");
    } catch {
      throw new Error(
        "The browser could not preserve the selected source. Check browser storage before continuing.",
      );
    }
    return record;
  });
}

export function verifySelectedSource(
  storage: Pick<Storage, "getItem">,
  actorId: string,
  observed: string,
  expected: { projectId: string; revision: number },
) {
  const current = storage.getItem(blankSourceKey(actorId));
  const selected = current === observed ? selectedExistingSource(current, actorId) : null;
  if (
    !selected ||
    selected.projectId !== expected.projectId ||
    selected.revision !== expected.revision
  )
    throw new Error(
      "The selected source changed or was removed in another tab. Reload and review the current source before submitting.",
    );
  return selected;
}

export function adoptedBlankSource(stored: string, actorId: string) {
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value) || readField(value, "actorId") !== actorId) return null;
    const receipt = readField(value, "receipt");
    const operationId = readField(value, "operationId");
    const title = readField(value, "title");
    const revision = readField(value, "currentRevision");
    if (
      readField(value, "adopted") !== true ||
      !isId(operationId) ||
      !projectReceipt(receipt) ||
      typeof title !== "string" ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      return null;
    return { projectId: receipt.projectId, title, revision, operationId };
  } catch {
    return null;
  }
}

export async function adoptBlankSource(
  storage: Store,
  actorId: string,
  observed: string | null,
  operationId: string,
  receipt: unknown,
  source: { projectId: string; title: string; revision: number },
  signal?: AbortSignal,
) {
  if (
    !isId(operationId) ||
    !projectReceipt(receipt) ||
    receipt.projectId !== source.projectId ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0
  )
    throw new Error("The recovered source could not be verified.");
  const key = blankSourceKey(actorId);
  await navigator.locks.request(key, async () => {
    signal?.throwIfAborted();
    if (storage.getItem(key) !== observed)
      throw new Error(
        "The saved source changed in another tab. Refresh recovery before choosing it.",
      );
    if (observed !== null) {
      let prior: unknown;
      try {
        prior = JSON.parse(observed);
      } catch {
        throw new Error(
          "Resolve the earlier browser source record before adopting another source.",
        );
      }
      const priorOperationId = isRecord(prior) ? readField(prior, "operationId") : undefined;
      if (
        !isRecord(prior) ||
        (priorOperationId !== undefined
          ? priorOperationId !== operationId
          : blankSourceProject(observed)?.projectId !== source.projectId)
      )
        throw new Error(
          "A different source request is still saved. Resolve it before adopting another source.",
        );
    }
    const record = JSON.stringify({
      actorId,
      operationId,
      adopted: true,
      title: source.title,
      currentRevision: source.revision,
      receipt,
    });
    try {
      storage.setItem(key, record);
      if (storage.getItem(key) !== record) throw new Error("Storage unavailable");
    } catch {
      throw new Error(
        "The browser could not preserve the recovered source. Check browser storage before acknowledging it.",
      );
    }
  });
}

function validBlankSourceGuard(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || readField(value, "purpose") !== "assignment-source") return false;
  const predecessor = readField(value, "previousOperationId");
  return predecessor === null || isId(predecessor);
}

export function blankSourceProject(
  stored: string,
): { projectId: string; imageKey?: string } | null {
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return null;
    const receipt = readField(value, "receipt");
    const imageKey = readField(value, "imageKey");
    if (
      !projectReceipt(receipt) ||
      (imageKey !== undefined && typeof imageKey !== "string") ||
      !validBlankSourceGuard(readField(value, "creationGuard"))
    )
      return null;
    return {
      projectId: receipt.projectId,
      ...(imageKey !== undefined ? { imageKey } : {}),
    };
  } catch {
    return null;
  }
}

export function blankSourceAttempt(stored: string) {
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return null;
    const imageKey = readField(value, "imageKey");
    if (
      !isId(readField(value, "operationId")) ||
      typeof readField(value, "title") !== "string" ||
      typeof readField(value, "environmentAssetId") !== "string" ||
      (imageKey !== undefined && typeof imageKey !== "string") ||
      !validBlankSourceGuard(readField(value, "creationGuard"))
    )
      return null;
    return value as {
      operationId: string;
      title: string;
      environmentAssetId: string;
      imageKey?: string;
      creationGuard?: { purpose: "assignment-source"; previousOperationId: string | null };
    };
  } catch {
    return null;
  }
}

export async function clearBlankSource(
  storage: Store,
  actorId: string,
  expected: { record: string | null } | { projectId: string },
): Promise<boolean> {
  const key = blankSourceKey(actorId);
  return navigator.locks.request(key, () => {
    const stored = storage.getItem(key);
    if (stored === null) return false;
    if (
      "record" in expected
        ? stored !== expected.record
        : (selectedExistingSource(stored, actorId)?.projectId ??
            blankSourceProject(stored)?.projectId) !== expected.projectId
    )
      return false;
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error("The source record could not be cleared.");
    return true;
  });
}

export async function createBlankSource(
  storage: Store,
  write: Write,
  actorId: string,
  title: string,
  environmentAssetId: string,
  readSource: ReadSource,
  image?: EncodedProjectImage,
  readHead: ReadCreationHead = loadCreationHead,
): Promise<
  | { kind: "confirmed"; projectId: string; revision: number }
  | { kind: "unknown" }
  | { kind: "source-unavailable" }
  | { kind: "image-mismatch" }
  | { kind: "rejected"; message: string; code?: string }
> {
  const key = blankSourceKey(actorId);
  let dispatched = false;
  let discovering = false;
  try {
    const imageKey = image
      ? Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(image))),
          ),
        )
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("")
      : undefined;
    const saved = storage.getItem(key);
    if (saved !== null) {
      const selected = selectedExistingSource(saved, actorId);
      if (selected) {
        const current = await readSource(actorId, selected.projectId);
        if (current.kind === "unavailable") return { kind: "source-unavailable" };
        if (current.kind === "retry" || current.revision !== selected.revision)
          return {
            kind: "rejected",
            message: "Review the selected existing source's current revision before continuing.",
          };
        return { kind: "confirmed", projectId: selected.projectId, revision: current.revision };
      }
      const receipt = blankSourceProject(saved);
      if (receipt) {
        const stored: unknown = JSON.parse(saved);
        const operationId = isRecord(stored) ? readField(stored, "operationId") : undefined;
        if (
          isRecord(stored) &&
          (isRecord(readField(stored, "creationGuard")) || readField(stored, "adopted") === true) &&
          isId(operationId)
        ) {
          discovering = true;
          await readHead(actorId, "assignment-source");
          discovering = false;
          if (
            (await acknowledgeCreation(actorId, "assignment-source", operationId, write, readHead))
              .kind !== "confirmed"
          )
            return { kind: "unknown" };
        }
        if (receipt.imageKey !== imageKey) return { kind: "image-mismatch" };
        const current = await readSource(actorId, receipt.projectId);
        if (current.kind === "unavailable") return { kind: "source-unavailable" };
        if (current.kind === "retry")
          return {
            kind: "rejected",
            message: "The source project could not be checked. Try again.",
          };
        return { kind: "confirmed", projectId: receipt.projectId, revision: current.revision };
      }
      const attempt = blankSourceAttempt(saved);
      if (!attempt) return { kind: "unknown" };
      if (
        attempt.title !== title ||
        attempt.environmentAssetId !== environmentAssetId ||
        attempt.imageKey !== imageKey
      )
        return {
          kind: "rejected",
          message:
            "Retry the earlier project with the same title, space and image, or explicitly start a new project.",
        };
    }
    discovering = true;
    const head = await readHead(actorId, "assignment-source");
    discovering = false;
    if (saved === null && head.state === "unacknowledged")
      return {
        kind: "rejected",
        code: "creation_recovery_required",
        message:
          "An earlier source project is awaiting review, possibly from another browser. Choose the recovered source explicitly before creating another.",
      };
    const operationId =
      saved !== null ? blankSourceAttempt(saved)!.operationId : crypto.randomUUID();
    const creationGuard =
      saved !== null
        ? blankSourceAttempt(saved)!.creationGuard
        : { purpose: "assignment-source", previousOperationId: head.operationId };
    const marker = JSON.stringify({
      operationId,
      ...(creationGuard ? { creationGuard } : {}),
      title,
      environmentAssetId,
      ...(imageKey ? { imageKey } : {}),
    });
    storage.setItem(key, marker);
    if (storage.getItem(key) !== marker)
      return { kind: "rejected", message: "The browser could not save recovery information." };
    dispatched = true;
    const outcome = await write(actorId, "/api/v1/projects", "POST", {
      operationId,
      ...(creationGuard ? { creationGuard } : {}),
      title,
      ...(environmentAssetId ? { environmentAssetId } : {}),
      ...(image ? { image } : {}),
    });
    if (outcome.kind === "rejected") {
      if (outcome.code === "creation_state_changed") {
        await readHead(actorId, "assignment-source");
        return {
          kind: "rejected",
          code: "creation_recovery_required",
          message:
            "Source creation state changed in another browser. Review server recovery before continuing; this request was not reissued.",
        };
      }
      if (saved === null && outcome.code !== "operation_conflict") storage.removeItem(key);
      return outcome;
    }
    if (outcome.kind !== "confirmed" || !projectReceipt(outcome.value)) return { kind: "unknown" };
    storage.setItem(
      key,
      JSON.stringify({
        operationId,
        ...(creationGuard ? { creationGuard } : {}),
        title,
        environmentAssetId,
        ...(imageKey ? { imageKey } : {}),
        receipt: outcome.value,
      }),
    );
    if (creationGuard || (head.state === "unacknowledged" && head.operationId === operationId)) {
      if (
        (await acknowledgeCreation(actorId, "assignment-source", operationId, write, readHead))
          .kind !== "confirmed"
      )
        return { kind: "unknown" };
    }
    return {
      kind: "confirmed",
      projectId: String(outcome.value.projectId),
      revision: Number(outcome.value.revision),
    };
  } catch (cause) {
    if (dispatched) return { kind: "unknown" };
    return {
      kind: "rejected",
      message:
        discovering && cause instanceof Error
          ? cause.message
          : "The browser could not save recovery information. Check browser storage and try again.",
    };
  }
}
