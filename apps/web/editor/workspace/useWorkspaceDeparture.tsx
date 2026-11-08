import { useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";

export interface LeaveGuard {
  pending: boolean;
  dirty: boolean;
}

export function useWorkspaceDeparture(active: boolean, { dirty, pending }: LeaveGuard) {
  const [leave, setLeave] = useState<(() => void) | null>(null);
  function navigate(action: () => void) {
    if (!active || pending) return;
    if (dirty) setLeave(() => action);
    else action();
  }
  const confirmation = active && leave && (
    <Dialog title="Leave this page?" onClose={() => setLeave(null)}>
      <p>Stay here to finish your changes, or discard them and leave.</p>
      <Button
        disabled={pending}
        onClick={() => {
          if (pending) return;
          setLeave(null);
          leave();
        }}
      >
        Discard details and leave
      </Button>
      <Button variant="primary" onClick={() => setLeave(null)}>
        Keep editing
      </Button>
    </Dialog>
  );
  return { navigate, confirmation };
}
