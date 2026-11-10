import { createContext, useContext, useLayoutEffect, useRef } from "react";

// A native modal escapes an inert ancestor, so gate its interaction explicitly.
export const ModalActivity = createContext<"active" | "checking" | "inactive">("active");

export function useModal(open: boolean) {
  const activity = useContext(ModalActivity);
  const visible = open && activity !== "inactive";
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!visible || !dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [visible]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.inert = activity !== "active";
    return () => {
      dialog.inert = false;
    };
  }, [activity]);
  return ref;
}
