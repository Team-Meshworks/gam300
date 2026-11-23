import { SelectionToggle } from "../../shared/ui/SelectionToggle";
import addAccountIcon from "@iconify-icons/lucide/user-plus";
import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { Icon as UiIcon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import faTrashCan from "@iconify-icons/lucide/trash-2";
import { useState, type ReactNode } from "react";
import { Avatar } from "../../shared/ui/Avatar";
import { SelectionBar } from "../../shared/ui/SelectionBar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import type { DirectoryAccount } from "./directory";

export interface AccountActions {
  onCreate: () => void;
  onView: (id: string) => void;
  onToggleActive: (id: string) => void;
  onDelete?: (id: string) => void;
  onDeleteAccounts?: (ids: string[]) => void;
  onHideAccounts?: (ids: string[]) => void;
  busy: boolean;
  canCreate: boolean;
}
export function AccountList({
  accounts,
  organizationName,
  onPreview,
  actions,
  loading,
  error,
  administration = false,
  onClose,
}: {
  accounts: readonly DirectoryAccount[];
  organizationName: string;
  onPreview: (title: string, body: ReactNode) => void;
  actions?: AccountActions | undefined;
  loading?: boolean;
  error?: string | undefined;
  administration?: boolean;
  onClose?: (() => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [accountCount, setAccountCount] = useState(accounts.length);
  const [selecting, setSelecting] = useState(false);
  const [role, setRole] = useState<"All" | "Students" | "Teachers">("All");
  const visible = accounts.filter(
    (account) =>
      (role === "All" || account.role === role) &&
      `${account.name} ${account.account}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selectable = visible;
  const picked = selectable.filter((account) => selected.includes(account.id));
  const allSelected = selectable.length > 0 && picked.length === selectable.length;
  const selectionAvailable = administration && Boolean(actions?.onDeleteAccounts);
  const canSelect = selectionAvailable && selecting;
  if (accountCount !== accounts.length) {
    setAccountCount(accounts.length);
    if (accounts.length < accountCount) {
      setSelected([]);
      setSelecting(false);
    }
  }
  function clearSelection() {
    setSelected([]);
  }
  return (
    <section
      className="sp-card sp-account-list"
      aria-label={`${organizationName} accounts`}
      aria-busy={loading}
    >
      <div className="sp-account-list-header">
        <div className="sp-account-search-row">
          <SearchField
            label="Search accounts"
            placeholder="Search by name or account"
            value={query}
            onChange={(value) => {
              setQuery(value);
              clearSelection();
            }}
          />
          {onClose && (
            <Button
              className="sp-close-button"
              aria-label="Close organisation"
              title="Close organisation"
              onClick={onClose}
            >
              <UiIcon icon={closeIcon} aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="sp-account-list-toolbar">
          <Tabs
            id="account-tabs"
            label="Account roles"
            value={role}
            onChange={(value) => {
              setRole(value);
              clearSelection();
            }}
            items={[
              {
                value: "All",
                label: actions
                  ? `All Accounts${loading || error ? "" : ` (${accounts.length})`}`
                  : "All",
              },
              {
                value: "Students",
                label: actions
                  ? `Creators${loading || error ? "" : ` (${accounts.filter((row) => row.role === "Students").length})`}`
                  : "Students",
              },
              {
                value: "Teachers",
                label: actions
                  ? `Facilitators${loading || error ? "" : ` (${accounts.filter((row) => row.role === "Teachers").length})`}`
                  : "Teachers",
              },
            ]}
          />
          {actions && (
            <div className="sp-account-toolbar-actions">
              <Button
                variant="quiet"
                className="sp-account-add"
                aria-label="Add Accounts"
                title="Add accounts"
                disabled={loading || Boolean(error) || actions.busy || !actions.canCreate}
                onClick={() => {
                  setSelecting(false);
                  clearSelection();
                  actions.onCreate();
                }}
              >
                <UiIcon icon={addAccountIcon} aria-hidden="true" width={20} height={20} />
              </Button>
              {selectionAvailable && (
                <SelectionToggle
                  selected={selecting}
                  label="Select accounts"
                  title="Select multiple accounts"
                  disabled={
                    loading ||
                    Boolean(error) ||
                    actions.busy ||
                    (!selecting && selectable.length === 0)
                  }
                  onClick={() => {
                    setSelecting(!selecting);
                    clearSelection();
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <div
        className="sp-account-rows"
        role="tabpanel"
        id="account-tabs-panel"
        aria-labelledby={`account-tabs-${role}`}
        tabIndex={0}
      >
        {error ? (
          <p className="sp-list-empty" role="alert">
            {error}
          </p>
        ) : loading ? (
          <LoadingSkeleton label="Loading accounts" />
        ) : (
          visible.map((account) => (
            <article
              className={`sp-account-row${canSelect ? " sp-account-row--selectable" : ""}${picked.some((row) => row.id === account.id) ? " is-selected" : ""}`}
              key={account.id}
            >
              {canSelect && (
                <input
                  className="sp-row-select-input"
                  type="checkbox"
                  aria-label={`Select ${account.role === "Students" ? "creator" : "facilitator"} ${account.name} (${account.account})`}
                  checked={selected.includes(account.id)}
                  disabled={actions?.busy}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, account.id]
                        : current.filter((id) => id !== account.id),
                    )
                  }
                />
              )}
              <div className="sp-account-row-top">
                <div className="sp-account">
                  {canSelect ? (
                    <span className="sp-selection-marker" aria-hidden="true" />
                  ) : (
                    <Avatar name={account.name} />
                  )}
                  <span className="sp-person-name">
                    <strong>{account.name}</strong>
                    <small>{account.account}</small>
                  </span>
                </div>
                {!administration && (
                  <span
                    className={`sp-badge${account.status === "Active" ? " sp-badge--success" : ""}`}
                  >
                    {account.status}
                  </span>
                )}
              </div>
              <div className="sp-account-row-bottom">
                <fieldset className="sp-actions" disabled={canSelect}>
                  <Button
                    variant="primary"
                    disabled={actions?.busy}
                    aria-label={`View account for ${account.name}`}
                    onClick={() => {
                      if (actions) actions.onView(account.id);
                      else
                        onPreview(
                          "Account details",
                          <>
                            <div className="sp-account">
                              <Avatar name={account.name} />
                              <h3>{account.name}</h3>
                            </div>
                            <dl className="sp-summary">
                              <dt>Account</dt>
                              <dd>{account.account}</dd>
                              <dt>Role</dt>
                              <dd>{account.role}</dd>
                              <dt>Status</dt>
                              <dd>{account.status}</dd>
                            </dl>
                          </>,
                        );
                    }}
                  >
                    View Account
                  </Button>
                  {actions && (
                    <Button
                      className={administration ? "sp-hide-action" : undefined}
                      disabled={actions.busy}
                      aria-label={`${administration ? (account.status === "Active" ? "Hide" : "Show") : account.status === "Active" ? "Disable" : "Enable"} account for ${account.name}`}
                      onClick={() => actions.onToggleActive(account.id)}
                    >
                      {administration && (
                        <UiIcon
                          icon={account.status === "Active" ? faEyeSlash : faEye}
                          aria-hidden="true"
                        />
                      )}
                      <span className="sp-button-label">
                        {administration
                          ? account.status === "Active"
                            ? "Hide"
                            : "Show"
                          : account.status === "Active"
                            ? "Disable"
                            : "Enable"}
                      </span>
                    </Button>
                  )}
                  {administration && actions?.onDelete && (
                    <Button
                      disabled={actions.busy}
                      className="sp-destructive-action"
                      aria-label={`Delete account for ${account.name}`}
                      onClick={() => actions.onDelete?.(account.id)}
                    >
                      <UiIcon icon={faTrashCan} aria-hidden="true" />
                      <span className="sp-button-label">Delete</span>
                    </Button>
                  )}
                </fieldset>
                {!administration && (
                  <span className="sp-hint">
                    {account.role === "Students" ? "Creator" : "Facilitator"}
                  </span>
                )}
              </div>
              {administration && (
                <dl className="sp-account-row-metadata">
                  <div>
                    <dt>Account Status</dt>
                    <dd className={account.status === "Active" ? "is-active" : undefined}>
                      {account.status}
                    </dd>
                  </div>
                  <div>
                    <dt>Account Type</dt>
                    <dd>{account.role === "Students" ? "Creator" : "Facilitator"}</dd>
                  </div>
                </dl>
              )}
            </article>
          ))
        )}
        {!loading && !error && !visible.length && (
          <p className="sp-list-empty" role="status">
            {accounts.length === 0 && administration && actions && !actions.canCreate
              ? "This organisation is hidden. Show the organisation before adding accounts."
              : accounts.length
                ? query.trim() || role === "All"
                  ? "No matching accounts. Try another name."
                  : role === "Teachers"
                    ? "No facilitators in this organisation yet."
                    : "No creators in this organisation yet."
                : "No accounts yet. Add the first account to this organisation."}
          </p>
        )}
      </div>
      <SelectionBar
        className="sp-account-selection sp-account-selection-toolbar"

        hidden={!canSelect}

        label="Account selection"
      >
        <div className="sp-selection-summary">
          <span role="status">
            {picked.length ? `${picked.length} selected` : "Select accounts"}
          </span>
          <button
            type="button"
            className="sp-select-all-action"
            disabled={actions?.busy || selectable.length === 0}
            onClick={() => setSelected(allSelected ? [] : selectable.map((account) => account.id))}
          >
            <span className="sp-plain-label">{allSelected ? "Clear all" : "Select all"}</span>
          </button>
        </div>
        <div className="sp-account-selection-actions">
          {actions?.onHideAccounts && (
            <Button
              className="sp-account-bulk-hide"
              disabled={
                actions.busy ||
                picked.length === 0 ||
                picked.every((account) => account.status !== "Active")
              }
              onClick={() =>
                actions.onHideAccounts?.(
                  picked
                    .filter((account) => account.status === "Active")
                    .map((account) => account.id),
                )
              }
            >
              <UiIcon icon={faEyeSlash} aria-hidden="true" />
              <span className="sp-button-label">Hide selected</span>
            </Button>
          )}
          <Button
            className="sp-button--danger sp-account-bulk-delete"
            disabled={actions?.busy || picked.length === 0}
            onClick={() => actions?.onDeleteAccounts?.(picked.map((account) => account.id))}
          >
            <UiIcon icon={faTrashCan} aria-hidden="true" />
            <span className="sp-button-label">Delete selected</span>
          </Button>
        </div>
      </SelectionBar>
    </section>
  );
}
