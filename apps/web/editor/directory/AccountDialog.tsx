import { Icon as UiIcon } from "@iconify/react/offline";
import faCircleChevronDown from "@iconify-icons/lucide/circle-chevron-down";
import uploadIcon from "@iconify-icons/lucide/upload";
import checkIcon from "@iconify-icons/lucide/check";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import { useId, useRef, useState, type FormEvent } from "react";
import { importAccounts, downloadCredentials, readAccountCsv } from "./account-csv";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { Select } from "../../shared/ui/Select";
import {
  DirectoryWriteUnconfirmed,
  type AccountChanges,
  type ManagedAccount,
} from "./directory-client";

export type NewAccount = {
  displayName: string;
  userName: string;
  role: "Creator" | "Educator";
  initialPassword: string;
};
export function AccountDialog({
  account,
  organizationName,
  onClose,
  onSave,
  onImport,
  onCheckDirectory,
}: {
  onCheckDirectory: () => void;
  onImport?: (values: NewAccount[]) => Promise<readonly string[]>;
  account?: ManagedAccount | undefined;
  organizationName: string;
  onClose: () => void;
  onSave: (values: NewAccount | AccountChanges) => Promise<void>;
}) {
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
  const [uncertainImport, setUncertainImport] = useState(false);
  const saving = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const [credentials, setCredentials] = useState<NewAccount[]>([]);
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
    setCredentials([]);
    try {
      if (file.size > 512 * 1024) throw new Error("Choose a CSV smaller than 512 KB.");
      const source = await readAccountCsv(file);
      const values = importAccounts(source, role);
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
  const enabled = (field: string) => !account || overrides[field] === true;
  const changed = !account || Object.values(overrides).some(Boolean);
  function close() {
    if (saving.current) return;
    if (uncertainImport) onCheckDirectory();
    else onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || uncertainImport || !changed) return;
    saving.current = true;
    setPending(true);
    setError("");
    try {
      if (!account && csvSource.current && onImport) {
        const values = importAccounts(csvSource.current, role).map((value, index) => ({
          ...value,
          initialPassword: credentials[index]!.initialPassword,
        }));
        const created = new Set(await onImport(values));
        if (created.size > 0) {
          try {
            downloadCredentials(values.filter((value) => created.has(value.userName)));
          } catch (cause) {
            throw new DirectoryWriteUnconfirmed("The credential file could not be generated.", {
              cause,
            });
          }
        }
        onClose();
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
      if (!account && csvSource.current && reason instanceof DirectoryWriteUnconfirmed) {
        setUncertainImport(true);
        setError(
          "The import or its credential file could not be confirmed. Check the directory for the intended accounts. For each account that needs new credentials, open View Account and override its temporary password before sharing it.",
        );
      } else setError(reason instanceof Error ? reason.message : "The account could not be saved.");
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
  return (
    <Dialog
      title={account ? "View Account Details" : "Account Creation"}
      variant="account"
      onClose={close}
    >
      <p className="sp-hint" title={account ? undefined : organizationName}>
        {account
          ? "Review and override account credentials"
          : "Add a new account into the organisation"}
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
                  {account.role === "Educator" ? "Facilitator" : "Creator"} · @{account.userName}
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
          disabled={pending || uncertainImport || !enabled("role")}
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
        <fieldset className="sp-credentials" disabled={pending || imported}>
          <legend className="sp-credentials-heading">
            <span>Account Credentials</span>
            {!account && onImport && (
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
                  disabled={pending}
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
                  <span>Upload CSV</span>
                </Button>
                <span id={csvHelpId} role="tooltip" className="sp-csv-tooltip" hidden={!csvHelp}>
                  Format in any order: Name, DOB (or Date of Birth), Account Type (optional).
                </span>
              </span>
            )}
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
                imported || error ? "sp-account-note-copy is-imported" : "sp-account-note-copy"
              }
              aria-hidden={Boolean(imported || error)}
            >
              <p className="sp-hint">Changes apply to this account only.</p>
              <p id="account-password-hint" className="sp-hint">
                {enabled("password")
                  ? "Use 12–128 characters. Users must change this password at first sign-in."
                  : "Existing passwords are private. Override to set a new temporary password."}
              </p>
            </div>
            {error && (
              <p role="alert" className="sp-account-error">
                {error}
              </p>
            )}
            {imported && !error && (
              <div className="sp-account-import-ready" role="status">
                <p className="sp-hint">
                  <UiIcon icon={checkIcon} aria-hidden="true" />
                  {credentials.length} accounts ready to import.
                </p>
                <p className="sp-hint">
                  Set the account type for rows without one, then save changes.
                </p>
              </div>
            )}
          </div>
          <div className="sp-actions">
            <Button onClick={close} disabled={pending}>
              {uncertainImport ? "Check account directory" : "Cancel"}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || uncertainImport || !changed}
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
