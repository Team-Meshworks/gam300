import { useId, type ReactNode } from "react";
import { Button } from "./Button";
import { useModal } from "./useModal";

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
  variant?: "account" | "wide" | "display" | "progress";
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
        // React propagates cancel through nested dialogs even though the native event does not bubble.
        event.stopPropagation();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {(variant === "account" || variant === "progress") && (
        <Button className="sp-dialog-dismiss" aria-label="Close dialog" onClick={onClose}>
          ×
        </Button>
      )}
      <div className="sp-dialog-body">{children}</div>
      {variant !== "account" && variant !== "display" && variant !== "progress" && (
        <Button onClick={onClose}>Close</Button>
      )}
    </dialog>
  );
}
