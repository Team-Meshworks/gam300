import { Icon as UiIcon } from "@iconify/react/offline";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import faTrashCan from "@iconify-icons/lucide/trash-2";
import { useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { createDashboardClient, type ProjectPublicationState } from "./dashboard-client";

type Action = "hide" | "show" | "delete";

export function ProjectModeration({
  projectId,
  client,
  state,
  onChanged,
}: {
  projectId: string;
  client: ReturnType<typeof createDashboardClient>;
  state: ProjectPublicationState | undefined;
  onChanged: (value: ProjectPublicationState) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false);
  const hidden = Boolean(state?.publicationCount && state.hiddenCount === state.publicationCount);
  const unavailable = !state || state.publicationCount === 0;
  const label = action === "delete" ? "Delete" : action === "show" ? "Show" : "Hide";

  async function review(requested: Action) {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    setUncertain(false);
    try {
      // Refresh visibility before confirmation so a stale row cannot choose the opposite action
      const current = (await client.publicationStates([projectId]))[projectId.toLowerCase()]!;
      onChanged(current);
      if (current.publicationCount === 0) {
        setError("There are no published editions to change.");
        return;
      }
      setAction(
        requested === "delete"
          ? "delete"
          : current.hiddenCount === current.publicationCount
            ? "show"
            : "hide",
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Publication visibility could not be checked.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function confirm() {
    if (busy.current || !action || uncertain) {
      return;
    }
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await client.moderatePublications(projectId, action);
      const current = (await client.publicationStates([projectId]))[projectId.toLowerCase()]!;
      onChanged(current);
      setAction(null);
    } catch {
      // A lost response may follow a committed change; require a fresh read before another attempt
      setUncertain(true);
      setError(
        "The result could not be confirmed. Close this dialog and reopen the controls to check the current state.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Button
        disabled={pending || unavailable}
        title={
          !state
            ? "Publication visibility unavailable"
            : unavailable
              ? "No published editions"
              : hidden
                ? "Restore publication visibility"
                : "Hide existing publications"
        }
        onClick={() => void review(hidden ? "show" : "hide")}
      >
        <UiIcon icon={hidden ? faEye : faEyeSlash} aria-hidden="true" />
        <span className="sp-button-label">{hidden ? "Show" : "Hide"}</span>
      </Button>
      <Button
        className="admin-publication-delete"
        disabled={pending || unavailable}
        title={
          !state
            ? "Publication visibility unavailable"
            : unavailable
              ? "No published editions"
              : "Delete existing publication links"
        }
        onClick={() => void review("delete")}
      >
        <UiIcon icon={faTrashCan} aria-hidden="true" />
        <span className="sp-button-label">Delete</span>
      </Button>
      {error && !action && (
        <p role="alert" className="admin-moderation-error">
          {error}
        </p>
      )}
      {action && (
        <Dialog
          title={`${label} Publications?`}
          variant="admin"
          onClose={() => {
            if (!busy.current) {
              setAction(null);
              setError("");
            }
          }}
        >
          <p>
            {action === "delete"
              ? "Permanently disable all existing publication links and QR codes for this project? The saved project, review history and shared assets will be retained. This cannot be undone."
              : action === "show"
                ? "Restore visibility for hidden editions? Archived, revoked and deleted publications will remain unavailable."
                : "Hide all existing publications for this project? Existing visitor links and QR codes will stop working until visibility is restored. The saved project stays editable."}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="sp-actions admin-moderation-dialog-actions">
            <Button
              disabled={pending}
              onClick={() => {
                setAction(null);
                setError("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending || uncertain}
              onClick={() => void confirm()}
            >
              {pending ? "Updating…" : label}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
