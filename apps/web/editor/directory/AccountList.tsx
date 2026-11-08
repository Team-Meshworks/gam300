import { useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEye, faEyeSlash, faTrashCan } from "@fortawesome/free-solid-svg-icons";
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
}: {
  accounts: readonly DirectoryAccount[];
  organizationName: string;
  onPreview: (title: string, body: ReactNode) => void;
  actions?: AccountActions | undefined;
  loading?: boolean;
  error?: string | undefined;
  administration?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"All" | "Students" | "Teachers">("All");
  const visible = accounts.filter(
    (account) =>
      (role === "All" || account.role === role) &&
      `${account.name} ${account.account}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section
      className="sp-card sp-account-list"
      aria-label={`${organizationName} accounts`}
      aria-busy={loading}
    >
      <div className="sp-account-list-header">
        <SearchField
          label="Search accounts"
          placeholder="Search by name or account"
          value={query}
          onChange={setQuery}
        />
        <div className="sp-account-list-toolbar">
          <Tabs
            id="account-tabs"
            label="Account roles"
            value={role}
            onChange={setRole}
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
            <Button
              variant="primary"
              disabled={loading || Boolean(error) || actions.busy || !actions.canCreate}
              onClick={actions.onCreate}
            >
              + Add Accounts
            </Button>
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
          <p className="sp-list-empty" role="status">
            Loading accounts…
          </p>
        ) : (
          visible.map((account) => (
            <article className="sp-account-row" key={account.id}>
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
                  {actions && (
                    <Button
                      disabled={actions.busy}
                      aria-label={`${administration ? (account.status === "Active" ? "Hide" : "Show") : account.status === "Active" ? "Disable" : "Enable"} account for ${account.name}`}
                      onClick={() => actions.onToggleActive(account.id)}
                    >
                      {administration && (
                        <FontAwesomeIcon
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
                      aria-label={`Delete account for ${account.name}`}
                      onClick={() => actions.onDelete?.(account.id)}
                    >
                      <FontAwesomeIcon icon={faTrashCan} aria-hidden="true" />
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
