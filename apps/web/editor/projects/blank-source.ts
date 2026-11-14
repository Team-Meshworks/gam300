import type { EncodedProjectImage } from "./project-image";
import { isId, isRecord, projectReceipt, type WriteResult } from "../home/workspace-api";

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
export const blankSourceKey = (actorId: string) => `spatia.assignment.source:${actorId}`;

// The old attemptId was local-only and cannot identify a server creation.
export function historicalBlankSource(stored: string): boolean {
  try {
    const value: unknown = JSON.parse(stored);
    if (
      !isRecord(value) ||
      value.operationId !== undefined ||
      value.creationGuard !== undefined ||
      value.actorId !== undefined ||
      value.adopted !== undefined ||
      value.selectedExisting !== undefined
    )
      return false;
    return (
      blankSourceProject(stored) !== null ||
      (isId(value.attemptId) &&
        typeof value.title === "string" &&
        typeof value.environmentAssetId === "string" &&
        (value.imageKey === undefined || typeof value.imageKey === "string"))
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
    if (
      !isRecord(value) ||
      value.actorId !== actorId ||
      value.operationId !== undefined ||
      value.receipt !== undefined ||
      value.adopted !== undefined ||
      value.attemptId !== undefined ||
      value.creationGuard !== undefined ||
      !isRecord(value.selectedExisting) ||
      !isId(value.selectedExisting.projectId) ||
      typeof value.selectedExisting.title !== "string" ||
      !Number.isSafeInteger(value.selectedExisting.revision) ||
      Number(value.selectedExisting.revision) < 0
    )
      return null;
    return {
      projectId: value.selectedExisting.projectId,
      title: value.selectedExisting.title,
      revision: Number(value.selectedExisting.revision),
    };
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
    if (
      !isRecord(value) ||
      value.actorId !== actorId ||
      value.adopted !== true ||
      !isId(value.operationId) ||
      !isRecord(value.receipt) ||
      !projectReceipt(value.receipt) ||
      !isId(value.receipt.projectId) ||
      typeof value.title !== "string" ||
      !Number.isSafeInteger(value.currentRevision) ||
      Number(value.currentRevision) < 0
    )
      return null;
    return {
      projectId: value.receipt.projectId,
      title: value.title,
      revision: Number(value.currentRevision),
      operationId: value.operationId,
    };
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
) {
  if (
    !isId(operationId) ||
    !isRecord(receipt) ||
    !projectReceipt(receipt) ||
    receipt.projectId !== source.projectId ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 0
  )
    throw new Error("The recovered source could not be verified.");
  const key = blankSourceKey(actorId);
  await navigator.locks.request(key, async () => {
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
      if (
        !isRecord(prior) ||
        (prior.operationId !== undefined
          ? prior.operationId !== operationId
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

export function blankSourceProject(
  stored: string,
): { projectId: string; imageKey?: string } | null {
  try {
    const value: unknown = JSON.parse(stored);
    if (
      !isRecord(value) ||
      !isRecord(value.receipt) ||
      !projectReceipt(value.receipt) ||
      typeof value.receipt.projectId !== "string" ||
      (value.imageKey !== undefined && typeof value.imageKey !== "string") ||
      (value.creationGuard !== undefined &&
        (!isRecord(value.creationGuard) ||
          value.creationGuard.purpose !== "assignment-source" ||
          !(
            value.creationGuard.previousOperationId === null ||
            isId(value.creationGuard.previousOperationId)
          )))
    )
      return null;
    return {
      projectId: value.receipt.projectId,
      ...(value.imageKey !== undefined ? { imageKey: value.imageKey } : {}),
    };
  } catch {
    return null;
  }
}

export function blankSourceAttempt(stored: string) {
  try {
    const value: unknown = JSON.parse(stored);
    if (
      !isRecord(value) ||
      !isId(value.operationId) ||
      typeof value.title !== "string" ||
      typeof value.environmentAssetId !== "string" ||
      (value.imageKey !== undefined && typeof value.imageKey !== "string") ||
      (value.creationGuard !== undefined &&
        (!isRecord(value.creationGuard) ||
          value.creationGuard.purpose !== "assignment-source" ||
          !(
            value.creationGuard.previousOperationId === null ||
            isId(value.creationGuard.previousOperationId)
          )))
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
        if (
          isRecord(stored) &&
          (isRecord(stored.creationGuard) || stored.adopted === true) &&
          isId(stored.operationId)
        ) {
          discovering = true;
          await readHead(actorId, "assignment-source");
          discovering = false;
          if (
            (
              await acknowledgeCreation(
                actorId,
                "assignment-source",
                stored.operationId,
                write,
                readHead,
              )
            ).kind !== "confirmed"
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
    if (outcome.kind !== "confirmed" || !projectReceipt(outcome.value) || !isRecord(outcome.value))
      return { kind: "unknown" };
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
