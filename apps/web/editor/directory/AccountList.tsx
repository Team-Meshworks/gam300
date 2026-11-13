import { Icon as UiIcon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import faEye from "@iconify-icons/lucide/eye";
import faEyeSlash from "@iconify-icons/lucide/eye-off";
import faTrashCan from "@iconify-icons/lucide/trash-2";
import selectAccountsIcon from "@iconify-icons/lucide/square-check";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import type { DirectoryAccount } from "./directory";

export interface AccountActions {
  onCreate: () => void;
  onView: (id: string) => void;
  onToggleActive: (id: string) => void;
  onDelete?: (id: string) => void;
  onDeleteStudents?: (ids: string[]) => void;
  onHideStudents?: (ids: string[]) => void;
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
  const [selecting, setSelecting] = useState(false);
  const [selectionHeight, setSelectionHeight] = useState(36);
  const [role, setRole] = useState<"All" | "Students" | "Teachers">("All");
  const visible = accounts.filter(
    (account) =>
      (role === "All" || account.role === role) &&
      `${account.name} ${account.account}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const students = visible.filter((account) => account.role === "Students");
  const picked = students.filter((account) => selected.includes(account.id));
  const allSelected = students.length > 0 && picked.length === students.length;
  const selectionAvailable = administration && Boolean(actions?.onDeleteStudents);
  const canSelect = selectionAvailable && selecting;
  useEffect(() => {
    if (
      selected.length > 0 &&
      selected.every((id) => !accounts.some((account) => account.id === id))
    ) {
      setSelected([]);
      setSelecting(false);
    }
  }, [accounts, selected]);
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
        <div className="sp-account-list-toolbar" hidden={canSelect}>
          <Tabs
            id="account-tabs"
            label="Account roles"
            value={role}
            onChange={(value) => {
              setRole(value);
              clearSelection();
            }}
            items={[
              { value: "All", label: actions ? `All Accounts (${accounts.length})` : "All" },
              {
                value: "Students",
                label: actions
                  ? `Creators (${accounts.filter((row) => row.role === "Students").length})`
                  : "Students",
              },
              {
                value: "Teachers",
                label: actions
                  ? `Facilitators (${accounts.filter((row) => row.role === "Teachers").length})`
                  : "Teachers",
              },
            ]}
          />
          {actions && (
            <div className="sp-account-toolbar-actions">
              {selectionAvailable && (
                <Button
                  className="sp-account-select-action"
                  aria-pressed={selecting}
                  aria-label={selecting ? "Done" : "Select accounts"}
                  title={selecting ? "Done selecting accounts" : "Select accounts"}
                  disabled={
                    loading ||
                    Boolean(error) ||
                    actions.busy ||
                    (!selecting && students.length === 0)
                  }
                  onClick={(event) => {
                    setSelectionHeight(
                      event.currentTarget
                        .closest(".sp-account-list-toolbar")
                        ?.getBoundingClientRect().height ?? 36,
                    );
                    setSelecting(true);
                    clearSelection();
                  }}
                >
                  <UiIcon icon={selecting ? closeIcon : selectAccountsIcon} aria-hidden="true" />
                </Button>
              )}
              <Button
                variant="primary"
                disabled={loading || Boolean(error) || actions.busy || !actions.canCreate}
                onClick={() => {
                  setSelecting(false);
                  clearSelection();
                  actions.onCreate();
                }}
              >
                + Add Accounts
              </Button>
            </div>
          )}
        </div>
        <div
          className="sp-account-selection sp-account-selection-toolbar"
          hidden={!canSelect}
          style={{ minHeight: selectionHeight }}
          role="group"
          aria-label="Account selection"
        >
          <label>
            <input
              type="checkbox"
              className="sp-selection-checkbox"
              aria-label="Select all creators"
              checked={allSelected}
              ref={(input) => {
                if (input) input.indeterminate = picked.length > 0 && !allSelected;
              }}
              disabled={actions?.busy || students.length === 0}
              onChange={() => setSelected(allSelected ? [] : students.map((account) => account.id))}
            />
            <span>Select all</span>
          </label>
          <div className="sp-account-selection-actions">
            <Button
              disabled={actions?.busy}
              onClick={() => {
                setSelecting(false);
                clearSelection();
              }}
            >
              Cancel
            </Button>
            {actions?.onHideStudents && (
              <Button
                className="sp-account-bulk-hide"
                disabled={
                  actions.busy ||
                  picked.length === 0 ||
                  picked.every((account) => account.status !== "Active")
                }
                onClick={() =>
                  actions.onHideStudents?.(
                    picked
                      .filter((account) => account.status === "Active")
                      .map((account) => account.id),
                  )
                }
              >
                <UiIcon icon={faEyeSlash} aria-hidden="true" />
                <span>Hide selected{picked.length > 0 ? ` (${picked.length})` : ""}</span>
              </Button>
            )}
            <Button
              className="sp-button--danger sp-account-bulk-delete"
              disabled={actions?.busy || picked.length === 0}
              onClick={() => actions?.onDeleteStudents?.(picked.map((account) => account.id))}
            >
              <UiIcon icon={faTrashCan} aria-hidden="true" />
              <span>Delete selected{picked.length > 0 ? ` (${picked.length})` : ""}</span>
            </Button>
          </div>
        </div>
      </div>
      <div
        className="sp-account-rows"
        role={canSelect ? "region" : "tabpanel"}
        id="account-tabs-panel"
        aria-label={canSelect ? "Select creator accounts" : undefined}
        aria-labelledby={canSelect ? undefined : `account-tabs-${role}`}
        tabIndex={0}
      >
        {error ? (
          <p className="sp-list-empty" role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className="sp-list-empty" role="status">
            Loading accounts…
          </p>
        ) : (
          visible.map((account) => (
            <article
              className={`sp-account-row${canSelect ? " sp-account-row--selectable" : ""}${picked.some((row) => row.id === account.id) ? " is-selected" : ""}`}
              key={account.id}
            >
              {canSelect && account.role === "Students" && (
                <label className="sp-account-selection-check">
                  <input
                    className="sp-account-select-row sp-selection-checkbox"
                    type="checkbox"
                    aria-label={`Select creator ${account.name} (${account.account})`}
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
                </label>
              )}
              <div className="sp-account-row-top">
                <div className="sp-account">
                  <Avatar name={account.name} />
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
                <div className="sp-actions">
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
                  {actions && !canSelect && (
                    <Button
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
                  {administration && actions?.onDelete && !canSelect && (
                    <Button
                      disabled={actions.busy}
                      aria-label={`Delete account for ${account.name}`}
                      onClick={() => actions.onDelete?.(account.id)}
                    >
                      <UiIcon icon={faTrashCan} aria-hidden="true" />
                      <span className="sp-button-label">Delete</span>
                    </Button>
                  )}
                </div>
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
            {accounts.length
              ? "No matching accounts. Try another name."
              : "No accounts yet. Add the first account to this organisation."}
          </p>
        )}
      </div>
    </section>
  );
}
