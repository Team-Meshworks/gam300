import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { downloadCredentials } from "./account-csv";
import { ImportRequestError, type BulkImport, type BulkImportReview } from "./bulk-import";

export function BulkImportHandoff({
  operation,
  operationId,
  local,
  initialReview,
  initialError,
  onClose,
}: {
  operation: BulkImport;
  operationId: string;
  local: boolean;
  initialReview: BulkImportReview | null;
  initialError: string;
  onClose: () => void;
}) {
  const [review, setReview] = useState(initialReview);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!local) return;
    return operation.watch(() => {
      try {
        if (operation.pending() !== operationId) onClose();
      } catch {
        setReview(null);
        setError("The import reference changed in another tab. Reopen the directory.");
      }
    });
  }, [local, operation, operationId, onClose]);

  async function act(action: "check" | "download" | "acknowledge" | "abandon") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      if (action === "acknowledge" || action === "abandon") {
        if (action === "acknowledge") await operation.acknowledge(operationId);
        else await operation.abandon(operationId);
        if (mounted.current) onClose();
        return;
      }
      const { credentials, ...status } = await operation.load(operationId);
      if (!mounted.current) return;
      setMissing(false);
      setReview(status);
      if (action === "download" && credentials.length) downloadCredentials(credentials);
    } catch (reason) {
      if (!mounted.current) return;
      setReview(null);
      if (
        reason instanceof ImportRequestError &&
        ["bulk_import_not_found", "bulk_import_abandoned"].includes(reason.code)
      ) {
        setMissing(local);
        setError(
          local
            ? "This import has no committed receipt. Check again, or cancel it before starting a new import."
            : "This import is no longer available. Refresh the directory to check current imports.",
        );
      } else {
        setMissing(false);
        setError(
          reason instanceof ImportRequestError && reason.code === "bulk_import_committed"
            ? "This import committed before cancellation. Check its receipt to recover the credential file."
            : reason instanceof Error
              ? reason.message
              : "The import receipt could not be verified. Check again.",
        );
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Dialog
      title="Account Creation"
      variant="account"
      closeDisabled={pending}
      onClose={() => {
        if (!busy.current) onClose();
      }}
    >
      <h3>Account import</h3>
      {error && <p role="alert">{error}</p>}
      {review ? (
        <>
          <p>{review.created.length} accounts created by this import.</p>
          {!!review.created.length && (
            <ul aria-label="Accounts created by this import">
              {review.created.map((item) => (
                <li key={item.userId}>
                  <strong>{item.displayName}</strong> · @{item.userName}
                </li>
              ))}
            </ul>
          )}
          {review.acknowledged ? (
            <p>The credential handoff has been acknowledged.</p>
          ) : review.available ? (
            <p>
              {review.available} temporary credentials are available until{" "}
              {new Date(review.expiresAt).toLocaleString()}. Acknowledge the handoff once you have
              the file.
            </p>
          ) : (
            !!review.created.length && (
              <p>
                Temporary credentials are no longer available. Use View Account to set a new
                temporary password for an intended account that needs one.
              </p>
            )
          )}
          {!review.acknowledged &&
            review.available > 0 &&
            review.available < review.created.length && (
              <p>
                Some accounts no longer have recoverable temporary credentials. The file contains
                only the credentials still available.
              </p>
            )}
        </>
      ) : (
        !error && (
          <p>
            Check this import to recover its confirmed account list and available temporary
            credentials.
          </p>
        )
      )}
      <div className="sp-actions">
        <Button disabled={pending} onClick={onClose}>
          Back to directory
        </Button>
        {!review && (
          <Button disabled={pending} onClick={() => void act("check")}>
            Check import receipt
          </Button>
        )}
        {missing && (
          <Button disabled={pending} onClick={() => void act("abandon")}>
            Cancel uncommitted import
          </Button>
        )}
        {review && (
          <>
            {review.available > 0 && (
              <Button disabled={pending} onClick={() => void act("download")}>
                Download credentials
              </Button>
            )}
            <Button disabled={pending} onClick={() => void act("acknowledge")}>
              {review.available > 0 ? "Acknowledge credential handoff" : "Finish import"}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
