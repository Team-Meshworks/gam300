import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { createAccountClient } from "../accounts/account-client";
import {
  acknowledgeCreation,
  creationReceipt,
  createOperationKey,
  duplicateCreateReceipt,
  loadCreationHead,
  readCreateOperation,
  releaseCreateOperation,
  type CreationHead,
  type CreationPurpose,
} from "./create-operation";
import { createWorkspaceClient, isId } from "./workspace-api";
import { isRecord, readField } from "../../shared/project/validation-helpers";
import "./pending-create-recovery.css";

const api = createWorkspaceClient();
const accounts = createAccountClient();
export type RecoveredCreation = { id: string; name: string; revision?: number; receipt: unknown };

type RecoveryProps = {
  actorId: string;
  purpose: CreationPurpose;
  active: boolean;
  onReleased?: () => void;
  onRecovered?: (value: RecoveredCreation) => void;
  prepareRecovered?: (
    value: RecoveredCreation,
    operationId: string,
    observed: string | null,
    signal: AbortSignal,
  ) => Promise<RecoveredCreation>;
  onPendingChange?: (pending: boolean) => void;
  historicalLocal?: boolean;
  refreshKey?: string;
};

function parseLocalRecovery(raw: string | null) {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function PendingCreateRecovery(props: RecoveryProps) {
  return props.active ? (
    <CreationRecoveryPanel
      key={JSON.stringify([props.actorId, props.purpose, props.refreshKey ?? ""])}
      {...props}
    />
  ) : null;
}

function CreationRecoveryPanel({
  actorId,
  purpose,
  active,
  onReleased,
  onRecovered,
  prepareRecovered,
  onPendingChange,
  historicalLocal = false,
}: RecoveryProps) {
  const [observed, setObserved] = useState<string | null>(null);
  const [head, setHead] = useState<CreationHead | null>(null);
  const [reviewed, setReviewed] = useState<RecoveredCreation | null>(null);
  const [rows, setRows] = useState<{ id: string; name: string }[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const discovery = useRef<AbortController | null>(null);
  const classes = purpose === "class";
  const label = classes ? "classes" : "projects";
  const key = createOperationKey(actorId, purpose);
  async function checkAccount(signal: AbortSignal) {
    const session = await accounts.getSession();
    signal.throwIfAborted();
    if (session?.userId !== actorId || session.mustChangePassword)
      throw new Error("The account changed. Reload before continuing.");
  }
  const showHead = useCallback(
    (current: CreationHead, signal: AbortSignal) => {
      signal.throwIfAborted();
      const raw = localStorage.getItem(key);
      setHead(current);
      setObserved(raw);
      setReviewed(null);
      setRows(null);
      onPendingChange?.(current.state !== "ready" || raw !== null);
    },
    [key, onPendingChange],
  );
  function refresh(signal: AbortSignal) {
    return loadCreationHead(actorId, purpose).then((current) => showHead(current, signal));
  }
  useLayoutEffect(() => {
    const controller = new AbortController();
    discovery.current = controller;
    void loadCreationHead(actorId, purpose)
      .then((current) => showHead(current, controller.signal))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setMessage(
          cause instanceof Error
            ? cause.message
            : "Creation recovery is unavailable. No creation will be sent.",
        );
        onPendingChange?.(true);
      });
    return () => controller.abort();
  }, [actorId, purpose, showHead, onPendingChange]);
  const local = parseLocalRecovery(observed);
  const localBody = local && readField(local, "body");
  const localId = isRecord(localBody)
    ? readField(localBody, "operationId")
    : local && readField(local, "operationId");
  const receipt =
    head?.state === "unacknowledged" ? head.receipt : local && readField(local, "receipt");
  const operationId = head?.state === "unacknowledged" ? head.operationId : localId;
  const recoverable =
    isId(operationId) &&
    receipt !== undefined &&
    receipt !== null &&
    creationReceipt(receipt, purpose);
  async function run(action: "refresh" | "review" | "list" | "acknowledge" | "release") {
    const signal = discovery.current?.signal;
    if (!active || !signal || signal.aborted || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      await checkAccount(signal);
      if (action === "refresh") {
        await refresh(signal);
        return;
      }
      if (!head) throw new Error("Creation recovery must be available before continuing.");
      if (action === "list") {
        setRows(null);
        const values = classes
          ? await api.pages("/api/v1/classes", signal, actorId)
          : (
              await Promise.all(
                [false, true].map((archived) =>
                  api.pages("/api/v1/projects?archived=" + archived, signal, actorId),
                ),
              )
            ).flat();
        await checkAccount(signal);
        const ids = new Set<string>();
        setRows(
          values.map((value) => {
            const id = isRecord(value) ? readField(value, classes ? "id" : "projectId") : undefined;
            const name = isRecord(value) ? readField(value, classes ? "name" : "title") : undefined;
            if (!isId(id) || typeof name !== "string" || ids.has(id))
              throw new Error("The current list could not be verified.");
            ids.add(id);
            return { id, name };
          }),
        );
      } else if (action === "review") {
        if (!recoverable || !isRecord(receipt))
          throw new Error(
            "This result is unavailable. Review the current list before acknowledging it.",
          );
        if (purpose === "duplicate" && localId === operationId) {
          const saved = readCreateOperation(localStorage, key, actorId);
          if (!duplicateCreateReceipt(receipt, saved))
            throw new Error(
              "The recovered copy does not match the saved source. Its result cannot be used.",
            );
        }
        if (classes) {
          const values = await api.pages("/api/v1/classes", signal, actorId);
          const found = values.find(
            (value) => isRecord(value) && readField(value, "id") === readField(receipt, "id"),
          );
          if (
            !isRecord(found) ||
            !("id" in found) ||
            !("name" in found) ||
            typeof found.name !== "string" ||
            !isId(found.id)
          )
            throw new Error(
              "The recovered class is no longer available. Review the current list before acknowledging it.",
            );
          await checkAccount(signal);
          setReviewed({ id: found.id, name: found.name, receipt });
        } else {
          if (!("projectId" in receipt) || !isId(receipt.projectId))
            throw new Error("The recovered project could not be verified.");
          const value = await api.read("/api/v1/projects/" + receipt.projectId, signal, actorId);
          if (
            !isRecord(value) ||
            !("projectId" in value) ||
            !("document" in value) ||
            !("revision" in value) ||
            value.projectId !== receipt.projectId ||
            !isRecord(value.document) ||
            !("title" in value.document) ||
            typeof value.document.title !== "string" ||
            !Number.isSafeInteger(value.revision) ||
            Number(value.revision) < 0
          )
            throw new Error("The recovered project could not be verified.");
          await checkAccount(signal);
          setReviewed({
            id: receipt.projectId,
            name: value.document.title,
            revision: Number(value.revision),
            receipt,
          });
        }
      } else if (action === "acknowledge") {
        if (!isId(operationId) || (!reviewed && rows === null))
          throw new Error("Review the recovered result or the current list first.");
        if (purpose === "assignment-source" && reviewed && !prepareRecovered)
          throw new Error("The selected source must be preserved before it can be acknowledged.");
        // Preserve an explicitly chosen source before acknowledging its server receipt so reload can resume it.
        const chosen =
          reviewed && prepareRecovered
            ? await prepareRecovered(reviewed, operationId, observed, signal)
            : reviewed;
        signal.throwIfAborted();
        const result = await acknowledgeCreation(actorId, purpose, operationId, api.write);
        signal.throwIfAborted();
        if (result.kind !== "confirmed")
          throw new Error(
            "Acknowledgement is unconfirmed. Refresh recovery before creating another request.",
          );
        if (purpose !== "assignment-source" && observed !== null && localId === operationId)
          await releaseCreateOperation(localStorage, actorId, purpose, observed);
        await refresh(signal);
        signal.throwIfAborted();
        if (chosen && onRecovered) onRecovered(chosen);
      } else {
        if (head.state !== "ready" || observed === null || rows === null)
          throw new Error("Review server recovery and the current list first.");
        if (!(await releaseCreateOperation(localStorage, actorId, purpose, observed)))
          throw new Error(
            "The saved request changed in another tab. Reload to review its current recovery state.",
          );
        await refresh(signal);
        signal.throwIfAborted();
        onReleased?.();
      }
    } catch (cause) {
      if (!signal.aborted)
        setMessage(
          cause instanceof Error ? cause.message : "Recovery could not be checked. Try again.",
        );
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  if (head?.state === "ready" && (observed === null || historicalLocal) && !message) return null;
  return (
    <section
      className="sp-creation-notice sp-create-recovery"
      aria-label={"Release pending " + purpose + " request"}
    >
      {!head ? (
        <p>{message || "Checking creation compatibility and server recovery…"}</p>
      ) : (
        <>
          {head.state === "unacknowledged" || recoverable ? (
            <>
              <p>
                A server creation result is awaiting review. It may belong to an earlier request or
                another browser. Choose it explicitly; its title is not proof that it was this
                form's request.
              </p>
              {recoverable && (
                <Button disabled={!active || busy} onClick={() => void run("review")}>
                  Review recovered {classes ? "class" : "project"}
                </Button>
              )}
              {reviewed && (
                <div>
                  <p>
                    Recovered {classes ? "class" : "project"}: {reviewed.name} ({reviewed.id})
                  </p>
                  <Button disabled={!active || busy} onClick={() => void run("acknowledge")}>
                    {purpose === "assignment-source"
                      ? "Use this recovered source project"
                      : classes
                        ? "Use this recovered class"
                        : "Open this recovered project"}
                  </Button>
                </div>
              )}
              {!reviewed && (
                <p>
                  If this result is unavailable or belongs to a different intent, review the current
                  list before acknowledging it. Acknowledgement does not cancel or delete a created
                  record.
                </p>
              )}
            </>
          ) : (
            <p>
              The saved request has no unreviewed server receipt. It may still complete later. Check
              the current list before releasing only this browser's saved request. A new request is
              a deliberate separate creation.
            </p>
          )}
          <Button disabled={!active || busy} onClick={() => void run("list")}>
            Check current {label}
          </Button>
          {rows !== null && (
            <div>
              <p>
                Current accessible {label}
                {classes ? ":" : ", including archived projects:"}
              </p>
              {rows.length ? (
                <ul>
                  {rows.map((row) => (
                    <li key={row.id}>{row.name}</li>
                  ))}
                </ul>
              ) : (
                <p>No accessible {label} were returned.</p>
              )}
              {head.state === "unacknowledged" ? (
                <Button disabled={!active || busy} onClick={() => void run("acknowledge")}>
                  I reviewed the list; acknowledge this server result
                </Button>
              ) : (
                observed !== null && (
                  <Button disabled={!active || busy} onClick={() => void run("release")}>
                    I checked the list; release this saved request
                  </Button>
                )
              )}
            </div>
          )}
        </>
      )}
      <Button disabled={!active || busy} onClick={() => void run("refresh")}>
        Refresh creation recovery
      </Button>
      {head && message && <p role="alert">{message}</p>}
    </section>
  );
}
