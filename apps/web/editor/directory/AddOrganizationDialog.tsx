import { useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Field } from "../../shared/ui/Field";
import type { createDashboardClient } from "../admin/dashboard-client";
import "../admin/dashboard.css";

export function AddOrganizationDialog({
  client,
  onClose,
  onCreated,
}: {
  client: Pick<ReturnType<typeof createDashboardClient>, "createOrganization">;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  async function submit() {
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await client.createOrganization(name);
      onCreated(name.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Please try again.");
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
      onClose={() => {
        if (!busy.current) onClose();
      }}
    >
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
    </Dialog>
  );
}
