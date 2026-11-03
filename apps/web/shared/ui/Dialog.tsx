import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./Button";

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
  variant?: "account";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      className={`sp-dialog${variant === "account" ? " sp-account-dialog" : ""}`}
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {variant === "account" && (
        <Button className="sp-dialog-dismiss" aria-label="Close dialog" onClick={onClose}>
          ×
        </Button>
      )}
      <div className="sp-dialog-body">{children}</div>
      {variant !== "account" && <Button onClick={onClose}>Close</Button>}
    </dialog>
  );
}
