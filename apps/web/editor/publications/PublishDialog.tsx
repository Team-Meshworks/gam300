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
