import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import close from "@iconify-icons/lucide/x";
import { useModal } from "../../shared/ui/useModal";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { PublicationPage } from "./PublicationPage";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import "../reviews/request-approval.css";
import "./publish-dialog.css";

const accounts = createAccountClient();

export function PublishDialog({
  actorId,
  projectId,
  save,
  isSaved,
  onClose,
}: {
  actorId: string;
  projectId?: string;
  save?: () => Promise<void>;
  isSaved?: () => boolean;
  onClose: () => void;
}) {
  const ref = useModal(true);
  const editor = useRef({ save, isSaved });
  const [session, setSession] = useState<AccountSession | null>(null);
  const [error, setError] = useState("");
  const [guard, setGuard] = useState<LeaveGuard>({ pending: false, dirty: false });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Keep the editor session alive while publishing reads its confirmed saved revision
        await editor.current.save?.();
        const identity = await accounts.getSession();
        if (
          identity?.userId !== actorId ||
          identity.mustChangePassword ||
          (editor.current.isSaved && !editor.current.isSaved())
        )
          throw new Error(
            "Your latest changes or account could not be verified. Close this popup and retry after saving.",
          );
        if (!cancelled) setSession(identity);
      } catch (failure) {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : "Your saved project could not be loaded.",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId]);
  function closeDialog() {
    if (!guard.pending) onClose();
  }
  return (
    <dialog
      ref={ref}
      className="creator-approval-dialog creator-publish-dialog"
      aria-labelledby="creator-publish-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      }}
    >
      <button
        className="creator-approval-close"
        aria-label="Close publish project"
        disabled={guard.pending}
        onClick={closeDialog}
      >
        <Icon icon={close} width={20} />
      </button>
      <h2 id="creator-publish-title">Publish project</h2>
      {!session && !error && <p role="status">Preparing your saved project...</p>}
      {error && <p role="alert">{error}</p>}
      {session && (
        <PublicationPage
          {...(projectId ? { projectId } : {})}
          session={session}
          onGuard={setGuard}
          onCancel={closeDialog}
        />
      )}
    </dialog>
  );
}
