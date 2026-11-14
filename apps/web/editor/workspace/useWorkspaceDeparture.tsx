import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";

export interface LeaveGuard {
  pending: boolean;
  dirty: boolean;
}

export function useWorkspaceDeparture(active: boolean, { dirty, pending }: LeaveGuard) {
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const confirmedDeparture = useRef(false);
  useLayoutEffect(() => {
    // Register before the forms' passive unload guards; cancellation cannot be undone later
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (confirmedDeparture.current) {
        confirmedDeparture.current = false;
        event.stopImmediatePropagation();
      }
    };
    const newGesture = () => {
      confirmedDeparture.current = false;
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pointerdown", newGesture, true);
    window.addEventListener("keydown", newGesture, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pointerdown", newGesture, true);
      window.removeEventListener("keydown", newGesture, true);
    };
  }, []);
  function navigate(action: () => void) {
    if (!active || pending) return;
    if (dirty) setLeave(() => action);
    else action();
  }
  const confirmation = active && leave && (
    <Dialog
      title="Leave this page?"
      className="sp-workspace-leave"
      hideFooterClose
      onClose={() => setLeave(null)}
    >
      <p>Your unsaved changes will be lost.</p>
      <div className="sp-actions">
        <Button
          disabled={pending}
          onClick={() => {
            if (pending) return;
            setLeave(null);
            // Allow this departure once; any new gesture restores normal unsaved-work protection
            confirmedDeparture.current = true;
            try {
              leave();
            } catch (error) {
              confirmedDeparture.current = false;
              throw error;
            }
          }}
        >
          Discard and leave
        </Button>
        <Button variant="primary" onClick={() => setLeave(null)}>
          Keep editing
        </Button>
      </div>
    </Dialog>
  );
  return { navigate, confirmation };
}
