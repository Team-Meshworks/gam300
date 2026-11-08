import { createContext, useContext, useLayoutEffect, useRef } from "react";

// A native modal escapes an inert ancestor. Leave the top layer while its workspace is gated.
export const ModalActivity = createContext(true);

export function useModal(open: boolean) {
  const active = useContext(ModalActivity);
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !active || !dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [active, open]);
  return ref;
}
