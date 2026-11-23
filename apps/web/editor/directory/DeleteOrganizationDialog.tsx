import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import type { createDirectoryClient, OrganizationDeletion } from "./directory-client";

export function DeleteOrganizationDialog({
  organizationId,
  organizationName,
  client,
  onClose,
  onDeleted,
}: {
  organizationId: string;
  organizationName: string;
  client: ReturnType<typeof createDirectoryClient>;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const [summary, setSummary] = useState<OrganizationDeletion | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    void client.deletion(organizationId).then(
      (value) => {
        if (!disposed) setSummary(value);
      },
      (reason: unknown) => {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : "Could not load deletion details.");
      },
    );
    return () => {
      disposed = true;
    };
  }, [client, organizationId]);
  async function remove() {
    if (!summary || confirmation !== summary.name || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await client.deleteOrganization(organizationId, confirmation);
      onDeleted(summary.name);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Deletion could not be confirmed. Refresh the directory.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const loading = !summary && !error;
  return (
    <Dialog
      title="Delete Organisation"
      variant="admin"
      className="sp-delete-organisation-dialog"
      loadingLabel={loading ? "Loading deletion details" : undefined}
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      {(summary || loading) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <p>
            Permanently delete <strong>{summary?.name ?? organizationName}</strong> and all its
            accounts and workspace data? This cannot be undone.
          </p>
          <ul>
            <li>{summary?.accounts ?? 0} accounts</li>
            <li>
              {summary?.classes ?? 0} classes and {summary?.assignments ?? 0} assignments
            </li>
            <li>{summary?.projects ?? 0} projects, including archived projects</li>
            <li>
              {summary?.submissions ?? 0} submissions and {summary?.reviews ?? 0} review decisions
            </li>
            <li>{summary?.publications ?? 0} published editions</li>
          </ul>
          <p>
            Members will lose access and published links will stop working. The shared asset library
            belongs to the platform and is kept.
          </p>
          <Field
            id="delete-organisation-name"
            label={`Type ${summary?.name ?? organizationName} to confirm`}
          >
            <input
              id="delete-organisation-name"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={busy}
              required
            />
          </Field>
          <div className="sp-actions">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="sp-button--danger"
              disabled={busy || !summary || confirmation !== summary.name}
            >
              {busy ? "Deleting…" : "Delete Organisation Permanently"}
            </Button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {!summary && error && <Button onClick={onClose}>Close</Button>}
    </Dialog>
  );
}
