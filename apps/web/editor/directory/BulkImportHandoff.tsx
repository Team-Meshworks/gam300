import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "../../shared/ui/Button";
import { downloadCredentials } from "./account-csv";
import { ImportRequestError, type BulkImport, type BulkImportReview } from "./bulk-import";

export type ImportRecovery = {
  result?: ReactElement;
  actions?: ReactElement;
  message: string;
  checking: boolean;
  retry: () => void;
  abandon?: () => void;
};

function RecoveryForm({
  render,
  state,
}: {
  render: (state: ImportRecovery) => ReactElement;
  state: ImportRecovery;
}) {
  return render(state);
}

export function BulkImportHandoff({
  operation,
  operationId,
  skippedRows,
  renderRecovery,
  onClose,
}: {
  operation: BulkImport;
  operationId: string;
  skippedRows: (review: BulkImportReview) => React.ReactNode;
  renderRecovery: (state: ImportRecovery) => ReactElement;
  onClose: () => void;
}) {
  const [review, setReview] = useState<BulkImportReview | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
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
    return operation.watch(() => {
      try {
        if (operation.pending() !== operationId) onClose();
      } catch {
        setReview(null);
        setError("The import reference changed in another tab. Reopen the directory.");
      }
    });
  }, [operation, operationId, onClose]);

  const act = useCallback(
    async (action: "check" | "download" | "acknowledge" | "abandon") => {
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
        if (action === "download" && credentials.length) {
          downloadCredentials(credentials);
          setDownloaded(true);
        }
      } catch (reason) {
        if (!mounted.current) return;
        setReview(null);
        if (
          reason instanceof ImportRequestError &&
          ["bulk_import_not_found", "bulk_import_abandoned"].includes(reason.code)
        ) {
          setMissing(true);
          setError("Check again or cancel this import before starting another.");
        } else {
          setMissing(false);
          setError(
            reason instanceof ImportRequestError && reason.code === "bulk_import_committed"
              ? "The accounts were created. Check again to get their login details."
              : action === "check"
                ? "We couldn't verify which accounts were created from this CSV."
                : reason instanceof Error
                  ? reason.message
                  : "The import status could not be checked. Try again.",
          );
        }
      } finally {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [onClose, operation, operationId],
  );

  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void act("check");
  }, [act]);

  if (!review) {
    return (
      <RecoveryForm
        render={renderRecovery}
        state={{
          message: error || "Checking import status...",
          checking: pending || !error,
          retry: () => void act("check"),
          ...(missing ? { abandon: () => void act("abandon") } : {}),
        }}
      />
    );
  }
  return (
    <RecoveryForm
      render={renderRecovery}
      state={{
        message: "",
        checking: pending,
        retry: () => void act("check"),
        result: (
          <div className="sp-hint" role="status">
            <p>
              {skippedRows(review) ??
                `${review.created.length} ${review.created.length === 1 ? "account" : "accounts"} created.`}
            </p>
            {!review.acknowledged && review.available < review.created.length && (
              <p>
                {review.available
                  ? `Passwords available for ${review.available} of ${review.created.length} accounts. `
                  : ""}
                Reset {review.available ? "the remaining" : "temporary"} passwords in View Account.
              </p>
            )}
          </div>
        ),
        actions: (
          <>
            {review.available > 0 && (
              <Button
                variant={downloaded ? "secondary" : "primary"}
                disabled={pending}
                onClick={() => void act("download")}
              >
                Download login details
              </Button>
            )}
            {(downloaded || review.available === 0) && (
              <Button variant="primary" disabled={pending} onClick={() => void act("acknowledge")}>
                Done
              </Button>
            )}
          </>
        ),
      }}
    />
  );
}
