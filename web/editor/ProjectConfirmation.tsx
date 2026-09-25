import { useEffect, useRef } from "react";

export function ProjectConfirmation({
  message,
  action,
  onChoice,
}: {
  message: string;
  action: string;
  onChoice: (accepted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    // Native modal focus containment keeps Tab inside our styled confirmation
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-confirmation"
      aria-labelledby="project-confirmation-title"
      // Escape follows the Cancel path so the waiting Open action can finish
      onCancel={(event) => {
        event.preventDefault();
        onChoice(false);
      }}
    >
      <h2 id="project-confirmation-title">Before you continue</h2>
      <p>{message}</p>
      <div>
        <button type="button" autoFocus onClick={() => onChoice(false)}>
          Cancel
        </button>
        <button type="button" onClick={() => onChoice(true)}>
          {action}
        </button>
      </div>
    </dialog>
  );
}
