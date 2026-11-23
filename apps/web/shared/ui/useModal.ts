import { fitConfirmationCopy } from "./fit-confirmation-copy";
import { createContext, useContext, useLayoutEffect, useRef } from "react";

// A native modal escapes an inert ancestor, so gate its interaction explicitly.
export const ModalActivity = createContext<"active" | "checking" | "inactive">("active");

export function useModal(open: boolean, fitConfirmation = false) {
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
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (
      !visible ||
      !fitConfirmation ||
      !dialog?.closest('[data-account-role="Administrator"], .sp-shell--facilitator')
    )
      return;
    const fit = () => fitConfirmationCopy(dialog);
    fit();
    const observer = new MutationObserver(fit);
    observer.observe(dialog, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", fit);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      document.fonts.removeEventListener("loadingdone", fit);
      dialog.style.removeProperty("width");
    };
  }, [visible, fitConfirmation]);
  return ref;
}
