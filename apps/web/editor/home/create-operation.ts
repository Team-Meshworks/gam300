import { createWorkspaceClient, isId, projectReceipt, type WriteResult } from "./workspace-api";
import { isRecord, readField } from "../../shared/project/validation-helpers";
import { createAccountClient } from "../accounts/account-client";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const creationPurposes = ["project", "class", "duplicate", "import", "assignment-source"] as const;
export type CreationPurpose = (typeof creationPurposes)[number];
export type CreationHead = {
  operationId: string | null;
  state: "ready" | "unacknowledged";
  receipt: unknown;
};
export type ReadCreationHead = (actorId: string, purpose: CreationPurpose) => Promise<CreationHead>;
type Write = (actorId: string, path: string, method: "POST", body: object) => Promise<WriteResult>;
export type CreateOperation = {
  actorId: string;
  path: string;
  body: {
    operationId: string;
    name?: unknown;
    orgId?: unknown;
    creationGuard?: { purpose: CreationPurpose; previousOperationId: string | null };
  };
  payloadDigest?: string;
  receipt?: unknown;
};
export const createOperationKey = (actorId: string, purpose: string) =>
  purpose === "assignment-source"
    ? `spatia.assignment.source:${actorId}`
    : `spatia.create:${actorId}:${purpose}`;

export function creationHead(value: unknown, purpose: CreationPurpose): CreationHead {
  if (
    !isRecord(value) ||
    !("operationId" in value) ||
    !("state" in value) ||
    !("receipt" in value) ||
    !(value.operationId === null || isId(value.operationId)) ||
    (value.state !== "ready" && value.state !== "unacknowledged") ||
    (value.state === "ready" ? value.receipt !== null : !isId(value.operationId)) ||
    (value.receipt !== null && !creationReceipt(value.receipt, purpose))
  )
    throw new Error(
      "Creation recovery is incompatible or unavailable. Your entries and saved request are unchanged. Update the app and server together before creating.",
    );
  return { operationId: value.operationId, state: value.state, receipt: value.receipt };
}

export function creationReceipt(value: unknown, purpose: CreationPurpose): boolean {
  return purpose === "class"
    ? isRecord(value) &&
        "id" in value &&
        "organizationId" in value &&
        "name" in value &&
        isId(value.id) &&
        isId(value.organizationId) &&
        typeof value.name === "string"
    : projectReceipt(value);
}

export async function loadCreationHead(
  actorId: string,
  purpose: CreationPurpose,
  request: typeof fetch = fetch,
): Promise<CreationHead> {
  const accounts = createAccountClient(request);
  if ((await accounts.getSession())?.userId !== actorId)
    throw new Error("The account changed. Reload before continuing.");
  let value: unknown;
  try {
    value = await createWorkspaceClient(request).read(
      "/api/v1/creation-operations/" + purpose,
      undefined,
      actorId,
    );
  } catch {
    throw new Error(
      "Creation recovery is incompatible or unavailable. No creation was sent. Update the app and server together, then retry.",
    );
  }
  const current = await accounts.getSession();
  if (current?.userId !== actorId || current.mustChangePassword)
    throw new Error("The account changed. Reload before continuing.");
  return creationHead(value, purpose);
}

export async function acknowledgeCreation(
  actorId: string,
  purpose: CreationPurpose,
  operationId: string,
  write: Write,
  readHead: ReadCreationHead = loadCreationHead,
): Promise<WriteResult> {
  const result = await write(
    actorId,
    "/api/v1/creation-operations/" + purpose + "/" + operationId + "/acknowledge",
    "POST",
    {},
  );
  if (result.kind === "confirmed" && result.value === null) return result;
  if (result.kind === "unknown") {
    try {
      const head = await readHead(actorId, purpose);
      if (head.state === "ready" && head.operationId !== null)
        return { kind: "confirmed", value: null };
    } catch {
      return { kind: "unknown" };
    }
  }
  return result.kind === "confirmed" ? { kind: "unknown" } : result;
}

export async function releaseCreateOperation(
  storage: Store,
  actorId: string,
  purpose: string,
  observed: string,
): Promise<boolean> {
  const key = createOperationKey(actorId, purpose);
  return navigator.locks.request(key, () => {
    if (storage.getItem(key) !== observed) return false;
    storage.removeItem(key);
    if (storage.getItem(key) !== null)
      throw new Error("The browser could not release this request.");
    return true;
  });
}

export function duplicateCreateReceipt(value: unknown, operation: CreateOperation | null): boolean {
  const sourceId = operation?.path.match(/^\/api\/v1\/projects\/([^/]+)\/duplicate$/)?.[1];
  return (
    isId(sourceId) &&
    projectReceipt(value) &&
    value.projectId.toLowerCase() !== sourceId.toLowerCase()
  );
}

function isCreationPurpose(value: unknown): value is CreationPurpose {
  return creationPurposes.some((purpose) => purpose === value);
}

function validCreateOperation(value: unknown, actorId: string): value is CreateOperation {
  if (!isRecord(value)) return false;
  const body = readField(value, "body");
  const path = readField(value, "path");
  const payloadDigest = readField(value, "payloadDigest");
  if (
    readField(value, "actorId") !== actorId ||
    typeof path !== "string" ||
    !/^\/api\/v1\/(projects(?:\/[0-9a-f-]{36}\/duplicate)?|classes)$/.test(path) ||
    !isRecord(body) ||
    !isId(readField(body, "operationId")) ||
    (payloadDigest !== undefined &&
      (typeof payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(payloadDigest)))
  )
    return false;

  const guard = readField(body, "creationGuard");
  if (guard === undefined) return true;
  if (!isRecord(guard)) return false;
  const predecessor = readField(guard, "previousOperationId");
  return (
    isCreationPurpose(readField(guard, "purpose")) && (predecessor === null || isId(predecessor))
  );
}

export function readCreateOperation(
  storage: Store,
  key: string,
  actorId: string,
): CreateOperation | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!validCreateOperation(value, actorId))
    throw new Error(
      "The saved creation request could not be verified. Check your projects or classes before continuing.",
    );
  return value;
}

export async function sendCreateOperation(
  storage: Store,
  key: string,
  actorId: string,
  write: Write,
  verify: (value: unknown) => boolean,
  input?: { path: string; body: object; retainBody?: false; retry?: true },
  readHead: ReadCreationHead = loadCreationHead,
): Promise<WriteResult> {
  let dispatched = false;
  try {
    if (!navigator.locks) throw new Error("This browser cannot safely coordinate creation.");
    return await navigator.locks.request(key, async () => {
      const purpose = key.slice(createOperationKey(actorId, "").length);
      if (!key.startsWith(createOperationKey(actorId, "")))
        throw new Error("The account scope could not be verified.");
      if (!isCreationPurpose(purpose))
        throw new Error("The creation purpose could not be verified.");
      const head = await readHead(actorId, purpose);
      const payloadDigest =
        input?.retainBody === false
          ? Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(JSON.stringify(input.body)),
                ),
              ),
            )
              .map((value) => value.toString(16).padStart(2, "0"))
              .join("")
          : undefined;
      let operation = readCreateOperation(storage, key, actorId);
      const resuming = operation !== null;
      if (!operation && head.state === "unacknowledged")
        return {
          kind: "rejected",
          code: "creation_recovery_required",
          message:
            "An earlier creation is awaiting review, possibly from another browser. Review the server recovery result before creating another.",
        };
      if (operation && input) {
        if (!input.retry)
          return {
            kind: "rejected",
            message: operation.receipt
              ? "An earlier creation succeeded. Review and accept its result before starting another."
              : "An earlier creation is pending. Retry its saved request before starting another.",
          };
        const {
          operationId: _operationId,
          creationGuard: _creationGuard,
          ...body
        } = operation.body;
        if (
          operation.path !== input.path ||
          (operation.payloadDigest
            ? operation.payloadDigest !== payloadDigest
            : JSON.stringify(body) !== JSON.stringify(input.body))
        )
          return {
            kind: "rejected",
            message: "Retry the earlier creation before starting another.",
          };
      }
      if (!operation) {
        if (!input) return { kind: "rejected", message: "There is no saved creation to retry." };
        operation = {
          actorId,
          path: input.path,
          body: {
            ...(payloadDigest ? {} : input.body),
            operationId: crypto.randomUUID(),
            creationGuard: { purpose, previousOperationId: head.operationId },
          },
          ...(payloadDigest ? { payloadDigest } : {}),
        };
        const raw = JSON.stringify(operation);
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw)
          throw new Error("The browser could not save recovery information.");
      }
      if (!operation.receipt && operation.payloadDigest && !input)
        return {
          kind: "rejected",
          message: "Select the same import file again to retry the saved creation.",
        };
      const raw = storage.getItem(key);
      dispatched = true;
      const result: WriteResult = operation.receipt
        ? { kind: "confirmed", value: operation.receipt }
        : await write(
            actorId,
            operation.path,
            "POST",
            operation.payloadDigest ? { ...input!.body, ...operation.body } : operation.body,
          );
      if (result.kind === "confirmed" && !verify(result.value)) return { kind: "unknown" };
      if (result.kind === "rejected" && result.code === "creation_state_changed") {
        await readHead(actorId, purpose);
        return {
          kind: "rejected",
          code: "creation_recovery_required",
          message:
            "Creation state changed in another browser. Review the server recovery result; this request was not reissued.",
        };
      }
      if (result.kind === "confirmed") {
        operation.receipt = result.value;
        const received = JSON.stringify(operation);
        if (storage.getItem(key) !== raw) return { kind: "unknown" };
        storage.setItem(key, received);
        if (storage.getItem(key) !== received) return { kind: "unknown" };
      }
      if (result.kind === "rejected" && !resuming && result.code !== "operation_conflict") {
        if (storage.getItem(key) !== raw) return { kind: "unknown" };
        storage.removeItem(key);
        if (storage.getItem(key) !== null)
          throw new Error("The browser could not clear recovery information.");
      }
      return result;
    });
  } catch (cause) {
    return dispatched
      ? { kind: "unknown" }
      : {
          kind: "rejected",
          message:
            cause instanceof Error
              ? cause.message
              : "The browser could not save recovery information.",
        };
  }
}
