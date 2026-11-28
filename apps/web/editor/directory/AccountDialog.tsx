import { Icon as UiIcon } from "@iconify/react/offline";
import faCircleChevronDown from "@iconify-icons/lucide/circle-chevron-down";
import uploadIcon from "@iconify-icons/lucide/upload";
import checkIcon from "@iconify-icons/lucide/check";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import { useId, useEffect, useRef, useState, type FormEvent } from "react";
import {
  importAccounts,
  downloadCredentials,
  readAccountCsv,
  type NewAccount,
  type SkippedRow,
} from "./account-csv";
import type { BulkImport, BulkImportReview } from "./bulk-import";
import { BulkImportHandoff, type ImportRecovery } from "./BulkImportHandoff";
import { RecoverableLoginFile } from "./RecoverableLoginFile";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Select } from "../../shared/ui/Select";
import type { AccountChanges, ManagedAccount } from "./directory-client";

export function AccountDialog({
  account: listedAccount,
  loadAccount,
  organizationName,
  onClose,
  onSave,
  bulkImport,
  onCheckDirectory,
}: {
  onCheckDirectory: () => void;
  bulkImport?: BulkImport | undefined;
  account?: ManagedAccount | undefined;
  loadAccount: (id: string) => Promise<ManagedAccount>;
  organizationName: string;
  onClose: () => void;
  onSave: (values: NewAccount | AccountChanges) => Promise<void>;
}) {
  const [details, setDetails] = useState<ManagedAccount | null>(null);
  const [loadError, setLoadError] = useState("");
  const account = details ?? listedAccount;
  const checking = Boolean(listedAccount && !details && !loadError);
  const [displayName, setName] = useState(account?.displayName ?? "");
  const [userName, setUsername] = useState(account?.userName ?? "");
  const [role, setRole] = useState<"Creator" | "Educator">(
    account?.role === "Educator" ? "Educator" : "Creator",
  );
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState<string | null>(() => {
    try {
      return bulkImport?.pending() ?? null;
    } catch {
      return null; // start() also validates storage before sending an import.
    }
  });

  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const upload = useRef<HTMLInputElement>(null);
  const [credentials, setCredentials] = useState<NewAccount[]>([]);
  useEffect(() => {
    if (!listedAccount) return;
    let active = true;
    void loadAccount(listedAccount.userId)
      .then((fresh) => {
        if (!active) return;
        if (fresh.userId !== listedAccount.userId || fresh.orgId !== listedAccount.orgId) {
          throw new Error("This account is no longer available in this organisation.");
        }
        setName(fresh.displayName);
        setUsername(fresh.userName);
        setRole(fresh.role === "Educator" ? "Educator" : "Creator");
        setDetails(fresh);
      })
      .catch((reason: unknown) => {
        if (active)
          setLoadError(
            reason instanceof Error ? reason.message : "Account details could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [listedAccount, loadAccount]);

  const [csvName, setCsvName] = useState("");
  const [skipped, setSkipped] = useState<SkippedRow[]>([]);
  const [createdCount, setCreatedCount] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState<{
    id: string;
    rows: { row: number; userName: string }[];
  } | null>(null);
  const csvSource = useRef<string | null>(null);
  const imported = credentials.length > 0;
  const [csvHelp, setCsvHelp] = useState(false);
  const csvHelpId = useId();
  async function uploadCsv(file: File | undefined) {
    if (!file || saving.current) return;
    saving.current = true;
    setPending(true);
    setError("");
    csvSource.current = null;
    setCreatedCount(null);
    setSkipped([]);
    setCredentials([]);
    try {
      if (file.size > 512 * 1024) throw new Error("Choose a CSV smaller than 512 KB.");
      const source = await readAccountCsv(file);
      const invalid: SkippedRow[] = [];
      const values = importAccounts(source, role, invalid);
      setSkipped(invalid);
      if (!values.length) setCreatedCount(0);
      setCsvName(file.name);
      csvSource.current = source;
      setCredentials(values);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The upload could not be confirmed. Refresh before retrying.",
      );
    } finally {
      saving.current = false;
      setPending(false);
      if (upload.current) upload.current.value = "";
    }
  }
  function importSkips(rows: { row: number; userName: string }[], receipt: BulkImportReview) {
    const created = new Set(receipt.created.map((account) => account.userName));
    return [
      ...skipped,
      ...rows
        .filter((account) => !created.has(account.userName))
        .map((account) => ({
          row: account.row,
          reason: "Account already exists",
        })),
    ].sort((a, b) => a.row - b.row);
  }
  function importSummary(created: number, items: SkippedRow[]) {
    const count = `${created} ${created === 1 ? "account" : "accounts"} created`;
    if (!items.length) return `${count}.`;
    const rows = items.map((item) => `row ${item.row}`).join(", ");
    return `${count}, ${items.length} ${items.length === 1 ? "row" : "rows"} skipped (${rows}).`;
  }
  const enabled = (field: string) => !account || overrides[field] === true;
  const changed = !account || Object.values(overrides).some(Boolean);
  function close() {
    if (saving.current) return;
    if (operationId || createdCount !== null) onCheckDirectory();
    else onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || operationId || createdCount !== null || !changed || checking || loadError)
      return;
    saving.current = true;
    setPending(true);
    setError("");
    try {
      if (!account && csvSource.current) {
        if (!bulkImport)
          throw new Error("The import is unavailable. Check the organisation directory.");
        const rows = importAccounts(csvSource.current, role, []);
        const values = rows.map(({ row: _row, ...value }, index) => ({
          ...value,
          initialPassword: credentials[index]!.initialPassword,
        }));
        const { credentials: available, ...receipt } = await bulkImport.start(values, (id) =>
          setSubmitted({ id, rows: rows.map(({ row, userName }) => ({ row, userName })) }),
        );
        if (!mounted.current) return;
        if (available.length) downloadCredentials(available);
        await bulkImport.downloadStarted(receipt.operationId);
        if (!mounted.current) return;
        const skippedRows = importSkips(rows, receipt);
        if (!skippedRows.length && available.length === rows.length) {
          onCheckDirectory();
          return;
        }
        setSkipped(skippedRows);
        setCreatedCount(receipt.created.length);
        setCredentials([]);
        csvSource.current = null;
        return;
      }
      await onSave(
        account
          ? {
              ...(enabled("displayName") ? { displayName: displayName.trim() } : {}),
              ...(enabled("userName") ? { userName: userName.trim() } : {}),
              ...(enabled("role") ? { role } : {}),
              ...(enabled("password") ? { newTemporaryPassword: password } : {}),
            }
          : {
              displayName: displayName.trim(),
              userName: userName.trim(),
              role,
              initialPassword: password,
            },
      );
    } catch (reason) {
      if (bulkImport && !account) {
        try {
          const stored = bulkImport.pending();
          if (stored) {
            setOperationId(stored);

            setError(
              "The import or credential download could not be confirmed. Check the import status before trying again.",
            );
            return;
          }
        } catch {
          setError(
            "The browser could not read the account import reference. Check browser storage before importing.",
          );
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : "The account could not be saved.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  function override(field: string, label: string) {
    return (
      account &&
      !enabled(field) && (
        <Button
          className="sp-override"
          aria-label={`Override ${label}`}
          disabled={pending}
          onClick={() => setOverrides((current) => ({ ...current, [field]: true }))}
        >
          Override
        </Button>
      )
    );
  }
  function renderForm(recovery?: ImportRecovery) {
    return (
      <Dialog
        title={account ? "View Account Details" : "Account Creation"}
        variant="account"
        loadingLabel={checking ? "Loading account details" : undefined}
        onClose={recovery?.checking ? () => {} : close}
        closeDisabled={pending || recovery?.checking === true}
      >
        {loadError ? (
          <p role="alert">{loadError}</p>
        ) : (
          <>
            <p className="sp-hint" title={account ? undefined : organizationName}>
              {account
                ? "Review and override account credentials."
                : "Add a new account into the organisation."}
            </p>
            <form
              className="sp-account-form"
              onSubmit={(event) => void submit(event)}
              aria-busy={pending}
            >
              {account && (
                <div className="sp-account-identity">
                  <div className="sp-account">
                    <Avatar name={account.displayName} />
                    <span className="sp-person-name">
                      <strong>{account.displayName}</strong>
                      <small>
                        {account.role === "Educator" ? "Facilitator" : "Creator"} · @
                        {account.userName}
                      </small>
                    </span>
                  </div>
                  <span className={`sp-badge${account.isActive ? " sp-badge--success" : ""}`}>
                    {account.isActive ? "Active" : "Inactive"}
                  </span>
                </div>
              )}
              <Select
                label="Account Type"
                className="sp-field sp-account-type-select"
                menuClassName="sp-account-type-menu"
                value={role}
                disabled={pending || !!recovery || createdCount !== null || !enabled("role")}
                options={[
                  { value: "Creator", label: "Creator" },
                  { value: "Educator", label: "Facilitator" },
                ]}
                onChange={(value) => setRole(value as "Creator" | "Educator")}
                leading={
                  <UiIcon
                    icon={faCircleChevronDown}
                    className="sp-account-type-icon"
                    aria-hidden="true"
                  />
                }
                trailing={override("role", "account type")}
              />
              <fieldset
                className="sp-credentials"
                disabled={pending || imported || !!recovery || createdCount !== null}
              >
                <legend className="sp-credentials-heading">
                  <span>Account Credentials</span>
                  <span className="sp-account-file-actions">
                    {bulkImport && !recovery && !imported && createdCount === null && (
                      <RecoverableLoginFile
                        operation={bulkImport}
                        disabled={pending}
                        onError={setError}
                      />
                    )}
                    {!account && bulkImport && (
                      <span
                        className="sp-csv-help"
                        onMouseEnter={() => setCsvHelp(true)}
                        onMouseLeave={() => setCsvHelp(false)}
                      >
                        <input
                          ref={upload}
                          type="file"
                          accept=".csv,text/csv"
                          hidden
                          onChange={(event) => void uploadCsv(event.target.files?.[0])}
                        />
                        <Button
                          className="sp-csv-action"
                          variant="quiet"
                          disabled={pending || !!recovery}
                          aria-describedby={csvHelpId}
                          onFocus={() => setCsvHelp(true)}
                          onBlur={() => setCsvHelp(false)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && csvHelp) {
                              event.preventDefault();
                              event.stopPropagation();
                              setCsvHelp(false);
                            }
                          }}
                          onClick={() => {
                            upload.current?.click();
                            setCsvHelp(false);
                          }}
                        >
                          <UiIcon icon={uploadIcon} aria-hidden="true" />
                          <span className="sp-button-label">
                            {(recovery || createdCount !== null) && csvName
                              ? csvName
                              : "Upload CSV"}
                          </span>
                        </Button>
                        <span
                          id={csvHelpId}
                          role="tooltip"
                          className="sp-csv-tooltip"
                          hidden={!csvHelp}
                        >
                          Format in any order: Name, DOB (or Date of Birth), Account Type
                          (optional).
                        </span>
                      </span>
                    )}
                  </span>
                </legend>
                <div className="sp-credential-grid">
                  <div className="sp-field">
                    <label htmlFor="account-name">Name</label>
                    <div className="sp-account-control">
                      <input
                        id="account-name"
                        value={displayName}
                        onChange={(event) => setName(event.target.value)}
                        disabled={!enabled("displayName")}
                        required
                        maxLength={256}
                        autoComplete="off"
                      />
                      {override("displayName", "name")}
                    </div>
                  </div>
                  <div className="sp-field">
                    <label htmlFor="account-username">Username</label>
                    <div className="sp-account-control">
                      <input
                        id="account-username"
                        value={userName}
                        onChange={(event) => setUsername(event.target.value)}
                        disabled={!enabled("userName")}
                        required
                        maxLength={256}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      {override("userName", "username")}
                    </div>
                  </div>
                  <div className="sp-field">
                    <label htmlFor="account-password">
                      {account && enabled("password") ? "New Password" : "Password"}
                    </label>
                    <div className="sp-account-control">
                      <input
                        id="account-password"
                        type={revealed ? "text" : "password"}
                        value={password}
                        placeholder={account && !enabled("password") ? "••••••••••••" : ""}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={!enabled("password")}
                        required
                        minLength={12}
                        maxLength={128}
                        autoComplete="new-password"
                        aria-describedby="account-password-hint"
                      />
                      <Button
                        className="sp-password-toggle"
                        aria-label={revealed ? "Hide password" : "Show password"}
                        aria-pressed={revealed}
                        title={
                          enabled("password")
                            ? revealed
                              ? "Hide password"
                              : "Show password"
                            : "Override to set a new temporary password"
                        }
                        disabled={pending || !enabled("password")}
                        onClick={() => setRevealed((current) => !current)}
                      >
                        <UiIcon icon={revealed ? faEye : faEyeSlash} aria-hidden="true" />
                      </Button>
                      {override("password", "password")}
                    </div>
                  </div>
                </div>
              </fieldset>
              <div className="sp-account-form-footer">
                <div className="sp-account-notes">
                  <div
                    className={
                      createdCount !== null || recovery || imported || error
                        ? "sp-account-note-copy is-imported"
                        : "sp-account-note-copy"
                    }
                    aria-hidden={Boolean(createdCount !== null || recovery || imported || error)}
                  >
                    <p id="account-password-hint" className="sp-hint sp-account-password-hint">
                      {enabled("password")
                        ? "Use 12–128 characters. Users must change this password at first sign-in."
                        : "Existing passwords are private. Override to set a new temporary password."}
                    </p>
                  </div>
                  {createdCount !== null && (
                    <p
                      className="sp-hint sp-csv-summary"
                      role="status"
                      title={skipped.map((item) => `Row ${item.row}: ${item.reason}`).join("\n")}
                    >
                      {importSummary(createdCount, skipped)}
                    </p>
                  )}
                  {recovery?.result}
                  {!recovery?.result && (recovery || error) && (
                    <p role="alert" className={recovery?.checking ? "sp-hint" : "sp-account-error"}>
                      {recovery?.message ?? error}
                    </p>
                  )}
                  {imported && !error && !recovery && (
                    <div className="sp-account-import-ready" role="status">
                      <p className="sp-hint">
                        <UiIcon icon={checkIcon} aria-hidden="true" />
                        {credentials.length} {credentials.length === 1 ? "account" : "accounts"}{" "}
                        ready to import.
                      </p>
                    </div>
                  )}
                </div>
                <div className="sp-actions">
                  {createdCount !== null ? (
                    <Button variant="primary" onClick={close}>
                      Done
                    </Button>
                  ) : (
                    (recovery?.actions ?? (
                      <>
                        {recovery?.abandon && (
                          <Button onClick={recovery.abandon} disabled={recovery.checking}>
                            Cancel pending import
                          </Button>
                        )}
                        {!recovery && (
                          <Button onClick={close} disabled={pending}>
                            Cancel
                          </Button>
                        )}
                        <Button
                          type={recovery ? "button" : "submit"}
                          onClick={recovery?.retry}
                          variant="primary"
                          disabled={pending || recovery?.checking || !changed}
                        >
                          {recovery
                            ? recovery.checking
                              ? "Checking..."
                              : "Check again"
                            : pending
                              ? "Saving…"
                              : "Save changes"}
                        </Button>
                      </>
                    ))
                  )}
                </div>
              </div>
            </form>
          </>
        )}
      </Dialog>
    );
  }
  if (operationId && bulkImport)
    return (
      <BulkImportHandoff
        key={operationId}
        operation={bulkImport}
        operationId={operationId}
        renderRecovery={renderForm}
        skippedRows={(receipt) =>
          submitted?.id === receipt.operationId
            ? importSummary(receipt.created.length, importSkips(submitted.rows, receipt))
            : null
        }
        onClose={onCheckDirectory}
      />
    );
  return renderForm();
}
