import { useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import type { createDashboardClient } from "../admin/dashboard-client";
import "../admin/dashboard.css";

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Please try again.";

export function AddOrganizationDialog({
  client,
  onClose,
  onCreated,
  onDirectory,
}: {
  client: Pick<
    ReturnType<typeof createDashboardClient>,
    "createOrganization" | "pendingOrganization" | "acknowledgeOrganization"
  >;
  onClose: () => void;
  onCreated?: (name: string) => void;
  onDirectory: (organizationId?: string) => void;
}) {
  const [recovery, setRecovery] = useState(() => {
    try {
      return { attempt: client.pendingOrganization(), error: "" };
    } catch (reason) {
      return { attempt: null, error: errorMessage(reason) };
    }
  });
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  async function submit() {
    if (busy.current || !name.trim() || recovery.attempt || recovery.error) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      const id = await client.createOrganization(name);
      if (onCreated) onCreated(name.trim());
      else onDirectory(id);
    } catch (reason) {
      setError(errorMessage(reason));
      try {
        setRecovery({ attempt: client.pendingOrganization(), error: "" });
      } catch (failure) {
        setRecovery({ attempt: null, error: errorMessage(failure) });
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  async function acknowledge() {
    if (!recovery.attempt || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await client.acknowledgeOrganization(recovery.attempt);
      setRecovery({ attempt: null, error: "" });
      setName("");
      setError("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      title="Add Organisation"
      variant="admin"
      className="admin-add-organisation-dialog sp-dialog--form"
      closeDisabled={pending}
      onClose={() => {
        if (!busy.current) onClose();
      }}
    >
      {recovery.attempt || recovery.error ? (
        <div className="admin-organisation-form" aria-busy={pending}>
          <p role="alert">
            {recovery.attempt
              ? recovery.attempt.name
                ? `Creation of “${recovery.attempt.name}” could not be confirmed. Check the directory before creating another organisation.`
                : "The previous organisation request could not be read. Check the directory before creating another organisation."
              : recovery.error}
          </p>
          <div className="sp-actions sp-form-dialog-actions">
            <Button disabled={pending} onClick={() => onDirectory()}>
              Check organisation directory
            </Button>
            {recovery.attempt && (
              <Button disabled={pending} onClick={() => void acknowledge()}>
                I checked the directory
              </Button>
            )}
          </div>
          {error && <p role="status">{error}</p>}
        </div>
      ) : (
        <form
          className="admin-organisation-form"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field id="organisation-name" label="Organisation name">
            <input
              id="organisation-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={256}
              required
              disabled={pending}
            />
          </Field>
          {error && <p role="alert">{error}</p>}
          <div className="sp-actions sp-form-dialog-actions">
            <Button
              disabled={pending}
              onClick={() => {
                if (!busy.current) onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
