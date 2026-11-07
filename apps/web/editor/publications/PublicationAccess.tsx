import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { createWorkspaceClient } from "../home/workspace-api";
import { Button } from "../../shared/ui/Button";
import {
  parsePublicationReference,
  publicationAccessState,
  type PublicationAccessState,
} from "./publication-access";

const api = createWorkspaceClient();
const accounts = createAccountClient();

export function PublicationAccess({
  projectId,
  session,
  initialId,
  onAvailabilityChange,
}: {
  projectId: string;
  session: AccountSession;
  initialId?: string | undefined;
  onAvailabilityChange?: ((id: string, available: boolean) => void) | undefined;
}) {
  const [reference, setReference] = useState(initialId ?? "");
  const [state, setState] = useState<PublicationAccessState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [refresh, setRefresh] = useState(false);
  const generation = useRef(0);
  const writePending = useRef(false);

  async function readAccess(id: string, token: number): Promise<PublicationAccessState | null> {
    try {
      const value = await api.read(`/api/v1/publications/${encodeURIComponent(id)}/access`);
      const current = await accounts.getSession();
      if (token !== generation.current) return null;
      if (current?.userId !== session.userId || current.mustChangePassword)
        throw new Error("Account changed");
      const checked = publicationAccessState(value, projectId, id);
      if (!checked) throw new Error("Access could not be verified");
      return checked;
    } catch {
      return null;
    }
  }

  async function checkAccess(input = reference) {
    if (writePending.current) return;
    const id = parsePublicationReference(input);
    const token = ++generation.current;
    setState(null);
    setConfirm(false);
    setRefresh(false);
    setMessage("");
    if (!id) {
      setMessage("Enter a valid publication link or ID.");
      return;
    }
    setBusy(true);
    const checked = await readAccess(id, token);
    if (token !== generation.current) return;
    setBusy(false);
    if (!checked) {
      onAvailabilityChange?.(id, false);
      setMessage(
        "Publication access could not be verified for this project. Check your access and try again.",
      );
      setRefresh(true);
      return;
    }
    setState(checked);
    onAvailabilityChange?.(
      checked.publicationId,
      !checked.hidden && !checked.revoked && !checked.deleted && !checked.archived,
    );
  }

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [projectId, session.userId],
  );

  async function revoke() {
    if (
      !state ||
      !state.canManage ||
      state.revoked ||
      state.deleted ||
      busy ||
      writePending.current
    )
      return;
    writePending.current = true;
    const current = state;
    const token = ++generation.current;
    setBusy(true);
    setRevoking(true);
    setConfirm(false);
    setMessage("");
    setState(null);
    onAvailabilityChange?.(current.publicationId, false);
    const result = await api.write(
      session.userId,
      `/api/v1/publications/${encodeURIComponent(current.publicationId)}/access`,
      "POST",
      {
        audience: current.audience,
        viewerIds: [...current.viewerIds],
        action: "revoke",
      },
    );
    writePending.current = false;
    if (token !== generation.current) return;
    if (result.kind !== "confirmed") {
      setBusy(false);
      setRevoking(false);
      setMessage(
        result.kind === "unknown"
          ? "The result could not be confirmed. Refresh access before trying again."
          : `${result.message} Refresh access before trying again.`,
      );
      setRefresh(true);
      return;
    }
    const checked = await readAccess(current.publicationId, token);
    if (token !== generation.current) return;
    setBusy(false);
    setRevoking(false);
    if (!checked || !checked.revoked) {
      setMessage("The result could not be confirmed. Refresh access before trying again.");
      setRefresh(true);
      return;
    }
    setState(checked);
    onAvailabilityChange?.(checked.publicationId, false);
  }

  return (
    <section className="sp-publication-access" aria-label="Manage publication access">
      <h3>Manage publication access</h3>
      <p>Check a publication from this project and revoke its access if you manage the project.</p>
      <label>
        Publication link or ID
        <input
          disabled={busy}
          maxLength={2048}
          value={reference}
          onChange={(event) => {
            generation.current += 1;
            setReference(event.target.value);
            setState(null);
            setMessage("");
            setConfirm(false);
            setRefresh(false);
            setBusy(false);
          }}
        />
      </label>
      <Button disabled={busy} onClick={() => void checkAccess()}>
        Check access
      </Button>
      {busy && (
        <p role="status">
          {revoking ? "Revoking publication access…" : "Checking publication access…"}
        </p>
      )}
      {message && <p role="alert">{message}</p>}
      {refresh && (
        <Button disabled={busy} onClick={() => void checkAccess()}>
          Refresh access
        </Button>
      )}
      {state && (
        <>
          <p>
            {state.audience === "Authenticated"
              ? "Authenticated: only permitted signed-in accounts can open this publication."
              : state.audience === "Public"
                ? "Public: anyone can open this publication without signing in."
                : "Unlisted: anyone with the link can open this publication without signing in."}
          </p>
          <p role="status">
            {state.deleted
              ? "Publication deleted"
              : state.revoked
                ? "Access revoked"
                : state.hidden
                  ? "Publication hidden"
                  : state.archived
                    ? "Project archived"
                    : "Access active"}
          </p>
          {state.canManage && !state.revoked && !state.deleted && (
            <Button disabled={busy} onClick={() => setConfirm(true)}>
              Revoke access
            </Button>
          )}
          {!state.canManage && <p>Only a project manager can revoke access.</p>}
          {confirm && (
            <div role="group" aria-label="Confirm revocation">
              <p>
                Revoke access to this publication? This cannot be undone. Existing links and QR
                codes will no longer grant access.
              </p>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button disabled={busy} onClick={() => void revoke()}>
                Confirm revoke
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
