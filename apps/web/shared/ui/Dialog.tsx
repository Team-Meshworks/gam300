import { useId, type ReactNode } from "react";
import { Button } from "./Button";
import { useModal } from "./useModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";

// Mount only while open; the native modal makes the background inert and contains focus
export function Dialog({
  title,
  children,
  onClose,
  variant,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: "account" | "wide" | "display" | "progress" | "admin";
}) {
  const ref = useModal(true);
  const titleId = useId();
  return (
    <dialog
      className={`sp-dialog${variant === "account" ? " sp-account-dialog" : variant === "wide" ? " sp-dialog--wide" : variant === "display" ? " sp-display-dialog" : variant === "progress" ? " sp-progress-dialog" : ""}`}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
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
          onClick={onClose}
        >
          <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
        </Button>
      )}
      <div className="sp-dialog-body">{children}</div>
      {variant !== "account" &&
        variant !== "display" &&
        variant !== "progress" &&
        variant !== "admin" && <Button onClick={onClose}>Close</Button>}
    </dialog>
  );
}
