import { Icon as UiIcon } from "@iconify/react/offline";
import downloadIcon from "@iconify-icons/lucide/download";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { downloadCredentials } from "./account-csv";
import type { BulkImport } from "./bulk-import";

export function RecoverableLoginFile({
  operation,
  disabled,
  onError,
}: {
  operation: BulkImport;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    let current = true;
    active.current = true;
    async function check() {
      try {
        const files = await operation.discover(true);
        if (current) setAvailable(files.length > 0);
      } catch {
        if (current)
          onError("Could not check for login details. Reopen Add Accounts to try again.");
      }
    }
    void check();
    window.addEventListener("focus", check);
    return () => {
      current = false;
      active.current = false;
      window.removeEventListener("focus", check);
    };
  }, [operation, onError]);

  async function download() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    onError("");
    try {
      const accounts = await operation.downloadAvailable();
      if (!active.current) return;
      if (accounts.length) downloadCredentials(accounts);
      else {
        setAvailable(false);
        onError("These login details are no longer available.");
      }
    } catch {
      if (active.current) onError("Could not download the login details. Try again.");
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }

  return available ? (
    <Button
      className="sp-csv-action sp-login-download"
      variant="quiet"
      disabled={disabled || pending}
      onClick={() => void download()}
    >
      <UiIcon icon={downloadIcon} aria-hidden="true" />
      <span className="sp-button-label">Download login details</span>
    </Button>
  ) : null;
}
