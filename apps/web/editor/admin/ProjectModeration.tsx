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
  projectIds,
  client,
  state,
  onChanged,
  requiresFreshApproval = false,
}: {
  projectId: string;
  projectIds?: string[];
  client: ReturnType<typeof createDashboardClient>;
  state: ProjectPublicationState | undefined;
  onChanged: (value: ProjectPublicationState) => void;
  requiresFreshApproval?: boolean;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const busy = useRef(false);
  const managesDraft =
    typeof state?.publishingBlocked === "boolean" && typeof state?.removed === "boolean";
  const hidden = managesDraft
    ? state!.publishingBlocked
    : Boolean(state?.publicationCount && state.hiddenCount === state.publicationCount);
  const unavailable =
    !state || state.removed === true || (!managesDraft && state.publicationCount === 0);
  const label = action === "delete" ? "Delete" : action === "show" ? "Show" : "Hide";

  async function readState() {
    const states = await client.publicationStates(projectIds ?? [projectId]);
    if (!projectIds) return states[projectId.toLowerCase()]!;
    const values = projectIds.map((id) => states[id.toLowerCase()]!);
    return {
      projectId,
      publicationCount: values.reduce((sum, value) => sum + value.publicationCount, 0),
      hiddenCount: values.reduce((sum, value) => sum + value.hiddenCount, 0),
      publicCount: values.reduce((sum, value) => sum + value.publicCount, 0),
      publishingBlocked: values.every((value) => value.publishingBlocked || value.removed),
      removed: values.every((value) => value.removed),
    };
  }

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
      const current = await readState();
      onChanged(current);
      if (
        current.removed ||
        (current.publishingBlocked === undefined && current.publicationCount === 0)
      ) {
        setError(
          current.removed
            ? "This student project has been removed."
            : "There are no published editions to change.",
        );
        return;
      }
      setAction(
        requested === "delete"
          ? "delete"
          : (current.publishingBlocked ??
              (current.publicationCount > 0 && current.hiddenCount === current.publicationCount))
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
      if (projectIds) {
        const states = await client.publicationStates(projectIds);
        for (const id of projectIds) {
          if (!states[id.toLowerCase()]!.removed) await client.moderatePublications(id, action);
        }
      } else {
        await client.moderatePublications(projectId, action);
      }
      const current = await readState();
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
          managesDraft
            ? hidden
              ? "Restore publishing eligibility; approval of the current submission is still required"
              : "Block publishing; the student can keep editing"
            : !state
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
          managesDraft
            ? "Remove the student project from the assignment and project list; stored work and review history are retained"
            : !state
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
          title={`${label} ${projectIds ? "Assignment Projects" : managesDraft ? "Student Project" : "Publications"}?`}
          variant="admin"
          className="sp-project-moderation-dialog"
          onClose={() => {
            if (!busy.current) {
              setAction(null);
              setError("");
            }
          }}
        >
          <p>
            {projectIds
              ? action === "delete"
                ? "Remove every student project from this assignment? Stored work and reviews remain. Publication links will stop working."
                : action === "show"
                  ? "Restore publishing eligibility for all student projects in this assignment? Each student still needs approval of their current submitted revision."
                  : "Block publishing for all student projects in this assignment? Students can keep editing. Existing visitor links will stop working."
              : managesDraft
                ? action === "delete"
                  ? "Remove this student project from the assignment and project list? Stored work and review history will be retained. Existing publication links will stop working."
                  : action === "show"
                    ? "Restore publishing eligibility? The student still needs approval of the current submitted revision."
                    : "The student can keep editing. Publishing and visitor access will be blocked until you show the project again."
                : action === "delete"
                  ? "Permanently disable all existing publication links and QR codes for this project? The saved project, review history and shared assets will be retained. This cannot be undone."
                  : action === "show"
                    ? "Restore visibility for hidden editions? Archived, revoked and deleted publications will remain unavailable."
                    : "Hide all existing publications for this project? Existing visitor links and QR codes will stop working until visibility is restored. The saved project stays editable."}
          </p>
          {requiresFreshApproval && action === "hide" && (
            <p>Publishing again requires a new submission and approval.</p>
          )}
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
