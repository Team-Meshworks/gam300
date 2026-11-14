import type { EncodedProjectImage } from "./project-image";
import { isRecord, projectReceipt, type WriteResult } from "../home/workspace-api";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Write = (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>;
type ReadSource = (
  actorId: string,
  projectId: string,
) => Promise<{ kind: "available"; revision: number } | { kind: "unavailable" } | { kind: "retry" }>;
export const blankSourceKey = (actorId: string) => `spatia.assignment.source:${actorId}`;

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
      (value.imageKey !== undefined && typeof value.imageKey !== "string")
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
        : blankSourceProject(stored)?.projectId !== expected.projectId
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
): Promise<
  | { kind: "confirmed"; projectId: string; revision: number }
  | { kind: "unknown" }
  | { kind: "source-unavailable" }
  | { kind: "image-mismatch" }
  | { kind: "rejected"; message: string }
> {
  const key = blankSourceKey(actorId);
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
      const receipt = blankSourceProject(saved);
      if (receipt) {
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
      return { kind: "unknown" };
    }
    const marker = JSON.stringify({
      attemptId: crypto.randomUUID(),
      title,
      environmentAssetId,
      ...(imageKey ? { imageKey } : {}),
    });
    storage.setItem(key, marker);
    if (storage.getItem(key) !== marker)
      return { kind: "rejected", message: "The browser could not save recovery information." };
    const outcome = await write(actorId, "/api/v1/projects", "POST", {
      title,
      ...(environmentAssetId ? { environmentAssetId } : {}),
      ...(image ? { image } : {}),
    });
    if (outcome.kind === "rejected") {
      storage.removeItem(key);
      return outcome;
    }
    if (outcome.kind !== "confirmed" || !projectReceipt(outcome.value) || !isRecord(outcome.value))
      return { kind: "unknown" };
    storage.setItem(
      key,
      JSON.stringify({
        title,
        environmentAssetId,
        ...(imageKey ? { imageKey } : {}),
        receipt: outcome.value,
      }),
    );
    return {
      kind: "confirmed",
      projectId: String(outcome.value.projectId),
      revision: Number(outcome.value.revision),
    };
  } catch {
    return { kind: "unknown" };
  }
}
