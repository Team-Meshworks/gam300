import "./confirmation-dialog.css";
import { Icon as UiIcon } from "@iconify/react/offline";
import faXmark from "@iconify-icons/lucide/x";
import { useId, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "./Button";
import { useModal } from "./useModal";

// Mount only while open; the native modal makes the background inert and contains focus
export function Dialog({
  title,
  children,
  onClose,
  variant,
  className = "",
  closeDisabled = false,
  hideFooterClose = false,
  loadingLabel,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: "account" | "wide" | "display" | "progress" | "admin";
  className?: string;
  closeDisabled?: boolean;
  hideFooterClose?: boolean;
  loadingLabel?: string | undefined;
}) {
  const ref = useModal(true, variant === "admin");
  const titleId = useId();
  const body = <div className="sp-dialog-body">{children}</div>;
  return (
    <dialog
      className={`sp-dialog${variant === "account" ? " sp-account-dialog sp-dialog--form" : variant === "wide" ? " sp-dialog--wide" : variant === "display" ? " sp-display-dialog" : variant === "progress" ? " sp-progress-dialog" : ""} ${className}`}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        // Keep cancellation inside the active dialog when React propagates it through nested dialogs
        event.stopPropagation();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {(variant === "account" || variant === "progress" || variant === "admin") && (
        <Button
          className="sp-dialog-dismiss sp-close-button"
          aria-label="Close dialog"
          disabled={closeDisabled}
          onClick={onClose}
        >
          <UiIcon icon={faXmark} aria-hidden="true" />
        </Button>
      )}
      {loadingLabel ? (
        <Skeleton loading label={loadingLabel} className="sp-dialog-loading">
          {body}
        </Skeleton>
      ) : (
        body
      )}
      {!hideFooterClose &&
        variant !== "account" &&
        variant !== "display" &&
        variant !== "progress" &&
        variant !== "admin" && <Button onClick={onClose}>Close</Button>}
    </dialog>
  );
}
