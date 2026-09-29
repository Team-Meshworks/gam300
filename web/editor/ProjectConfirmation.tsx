import { useEffect, useRef } from "react";
import type { ProjectDecision } from "./persistence/use-project-session";

export function ProjectConfirmation({
  fileName,
  busy,
  onChoice,
}: {
  fileName: string;
  busy: boolean;
  onChoice: (choice: ProjectDecision) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // Keep keyboard and pointer input inside the decision while switching projects
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-confirmation"
      aria-labelledby="project-confirmation-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onChoice("cancel");
      }}
    >
      <h2 id="project-confirmation-title">Save changes to {fileName}?</h2>
      <p>Your changes will be lost if you don’t save</p>
      <div>
        <button type="button" disabled={busy} autoFocus onClick={() => onChoice("cancel")}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => onChoice("discard")}>
          Don’t Save
        </button>
        <button type="button" disabled={busy} onClick={() => onChoice("save")}>
          {busy ? "Please wait…" : "Save"}
        </button>
      </div>
    </dialog>
  );
}
