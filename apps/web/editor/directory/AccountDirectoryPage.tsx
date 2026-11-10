import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { AccountDialog, type NewAccount } from "./AccountDialog";
import { OrganizationDirectory } from "./OrganizationDirectory";
import { DeleteOrganizationDialog } from "./DeleteOrganizationDialog";
import {
  createDirectoryClient,
  type AccountChanges,
  type ManagedAccount,
  type ManagedOrganization,
  type ManagedProject,
} from "./directory-client";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The directory could not be loaded.";
export function AccountDirectoryPage({ accountId }: { accountId: string }) {
  const [client] = useState(() => createDirectoryClient(fetch, accountId));
  const [organizations, setOrganizations] = useState<ManagedOrganization[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ManagedAccount | "create" | null>(null);
  const [preview, setPreview] = useState<{ title: string; body: ReactNode } | null>(null);
  const [toggle, setToggle] = useState<ManagedAccount | null>(null);
  const [deletingAccount, setDeletingAccount] = useState<ManagedAccount | null>(null);
  const [toggleOrganization, setToggleOrganization] = useState<ManagedOrganization | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pending = useRef(false);
  const selection = useRef(selected);
  useEffect(() => {
    let disposed = false;

    // Keep typing responsive while the server searches organisation and member names
    const timer = window.setTimeout(
      () => {
        void client.organizations(query).then(
          (items) => {
            if (!disposed) {
              setOrganizations(items);
              setError("");
              setLoading(false);
            }
          },
          (reason) => {
            if (!disposed) {
              setError(message(reason));
              setLoading(false);
            }
          },
        );
      },
      query ? 200 : 0,
    );
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [attempt, client, query]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    void Promise.allSettled([client.accounts(selected), client.projects(selected)]).then(
      ([rows, entries]) => {
        if (disposed) return;
        if (rows.status === "fulfilled") setAccounts(rows.value);
        else {
          setAccounts([]);
          setDetailError(message(rows.reason));
        }
        if (entries.status === "fulfilled") setProjects(entries.value);
        else {
          setProjects([]);
          setProjectError(message(entries.reason));
        }
        setDetailLoading(false);
      },
    );
    return () => {
      disposed = true;
    };
  }, [selected, attempt, client]);
  function select(id: string | null) {
    // Returning from organisation details refreshes totals after any account changes
    if (id === null) {
      setLoading(true);
      setAttempt((value) => value + 1);
    }
    selection.current = id;
    setSelected(id);
    setAccounts([]);
    setProjects([]);
    setDetailLoading(Boolean(id));
    setDetailError("");
    setProjectError("");
    setNotice("");
    setModal(null);
    setToggle(null);
    setDeleting(null);
    setToggleOrganization(null);
    setDeletingAccount(null);
  }
  function refresh() {
    setError("");
    setDetailError("");
    setProjectError("");
    setDetailLoading(Boolean(selected));
    if (!selected) setLoading(true);
    setAttempt((value) => value + 1);
  }
  async function view(id: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    const orgId = selected;
    try {
      const account = await client.getAccount(id);
      if (selection.current === orgId && account.orgId === orgId) setModal(account);
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save(values: NewAccount | AccountChanges) {
    if (!selected || !modal) return;
    const saved =
      modal === "create"
        ? await client.create(selected, values as NewAccount)
        : await client.update(modal.userId, values as AccountChanges);
    setAccounts((rows) => [...rows.filter((row) => row.userId !== saved.userId), saved]);
    setNotice(
      modal === "create"
        ? "Account created. Share the temporary password with its owner."
        : "Account changes saved.",
    );
    setModal(null);
  }
  async function toggleActive() {
    if (!toggle || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await client.setActive(toggle.userId, !toggle.isActive);
      setAccounts((rows) =>
        rows.map((row) =>
          row.userId === toggle.userId ? { ...row, isActive: !toggle.isActive } : row,
        ),
      );
      setNotice(toggle.isActive ? "Account hidden." : "Account shown.");
      setToggle(null);
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function deleteAccount() {
    if (!deletingAccount || pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await client.deleteAccount(deletingAccount.userId);
      setAccounts((rows) => rows.filter((row) => row.userId !== deletingAccount.userId));
      setNotice("Account deleted. Their authored work and history have been retained.");
      setDeletingAccount(null);
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function toggleOrganizationActive() {
    if (!toggleOrganization || pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      await client.setOrganizationActive(toggleOrganization.id, !toggleOrganization.isActive);
      setOrganizations(
        (items) =>
          items?.map((row) =>
            row.id === toggleOrganization.id
              ? { ...row, isActive: !toggleOrganization.isActive }
              : row,
          ) ?? null,
      );
      setNotice(toggleOrganization.isActive ? "Organisation hidden." : "Organisation shown.");
      setToggleOrganization(null);
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const organization = organizations?.find((row) => row.id === selected);
  if (loading && organizations === null) return <p role="status">Loading organisations…</p>;
  if (error && organizations === null)
    return (
      <div>
        <p role="alert">{error}</p>
        <Button onClick={refresh}>Retry</Button>
      </div>
    );
  return (
    <div className="sp-directory">
      {notice && <p role="status">{notice}</p>}
      <OrganizationDirectory
        administration
        searchQuery={query}
        onSearch={(value) => {
          if (value === query) {
            return;
          }
          setQuery(value);
          setLoading(true);
          setError("");
        }}
        searching={loading}
        searchError={error}
        organizations={(organizations ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          isActive: row.isActive,
          description: row.isActive ? "Active organisation" : "Inactive organisation",
          counts: {
            projects: row.projectCount,
            facilitators: row.facilitatorCount,
            creators: row.creatorCount,
          },
          accounts:
            row.id === selected
              ? accounts.map((item) => ({
                  id: item.userId,
                  name: item.displayName,
                  account: `@${item.userName}`,
                  role: item.role === "Creator" ? "Students" : "Teachers",
                  status: item.isActive ? "Active" : "Inactive",
                }))
              : [],
          projects: row.id === selected ? projects.map((item) => ({ ...item, creator: "" })) : [],
        }))}
        selectedId={selected}
        onSelect={select}
        onDelete={setDeleting}
        onToggleActive={(id) =>
          setToggleOrganization(organizations?.find((row) => row.id === id) ?? null)
        }
        busy={busy}
        loading={detailLoading}
        detailError={detailError}
        projectError={projectError}
        onPreview={(title, body) => setPreview({ title, body })}
        accountActions={{
          onCreate: () => setModal("create"),
          onView: (id) => void view(id),
          onToggleActive: (id) => {
            setNotice("");
            setToggle(accounts.find((row) => row.userId === id) ?? null);
          },
          onDelete: (id) => {
            setNotice("");
            setDeletingAccount(accounts.find((row) => row.userId === id) ?? null);
          },
          busy,
          canCreate: organization?.isActive === true,
        }}
      />
      {(detailError || projectError) && <Button onClick={refresh}>Retry organisation</Button>}
      {deleting && (
        <DeleteOrganizationDialog
          organizationId={deleting}
          client={client}
          onClose={() => setDeleting(null)}
          onDeleted={(name) => {
            setOrganizations((items) => items?.filter((item) => item.id !== deleting) ?? null);
            select(null);
            setNotice(`${name} and its accounts and workspace data were deleted.`);
          }}
        />
      )}
      {modal && organization && (
        <AccountDialog
          account={modal === "create" ? undefined : modal}
          organizationName={organization.name}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}
      {preview && (
        <Dialog title={preview.title} variant="admin" onClose={() => setPreview(null)}>
          {preview.body}
        </Dialog>
      )}
      {deletingAccount && (
        <Dialog
          title="Delete Account"
          variant="admin"
          onClose={() => {
            if (!pending.current) {
              setDeletingAccount(null);
            }
          }}
        >
          <p>
            Delete {deletingAccount.displayName} (@{deletingAccount.userName})? They will be signed
            out and cannot sign in again. Their username, authored projects and review history will
            be retained.
          </p>
          <div className="sp-actions sp-confirmation-actions">
            <Button disabled={busy} onClick={() => setDeletingAccount(null)}>
              Cancel
            </Button>
            <Button
              className="sp-button--danger"
              disabled={busy}
              onClick={() => void deleteAccount()}
            >
              {busy ? "Deleting…" : "Delete Account"}
            </Button>
          </div>
          {notice && <p role="alert">{notice}</p>}
        </Dialog>
      )}
      {toggleOrganization && (
        <Dialog
          title={`${toggleOrganization.isActive ? "Hide" : "Show"} Organisation`}
          variant="admin"
          onClose={() => {
            if (!pending.current) {
              setToggleOrganization(null);
            }
          }}
        >
          <p>
            {toggleOrganization.isActive
              ? `${toggleOrganization.name} members will lose access until the organisation is activated again. Existing projects, history and public visitor links will be kept.`
              : `${toggleOrganization.name} members with active accounts will be able to sign in again.`}
          </p>
          <div className="sp-actions sp-confirmation-actions">
            <Button disabled={busy} onClick={() => setToggleOrganization(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void toggleOrganizationActive()}
            >
              {busy ? "Saving…" : "Confirm"}
            </Button>
          </div>
          {notice && <p role="alert">{notice}</p>}
        </Dialog>
      )}
      {toggle && (
        <Dialog
          title={`${toggle.isActive ? "Hide" : "Show"} Account`}
          variant="admin"
          onClose={() => {
            if (!pending.current) setToggle(null);
          }}
        >
          <p>
            {toggle.isActive
              ? `${toggle.displayName} will lose access and be signed out. Their projects and history will be kept.`
              : `${toggle.displayName} will be able to sign in when their organisation is active.`}
          </p>
          <div className="sp-actions sp-confirmation-actions">
            <Button disabled={busy} onClick={() => setToggle(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void toggleActive()}>
              {busy ? "Saving…" : "Confirm"}
            </Button>
          </div>
          {notice && <p role="alert">{notice}</p>}
        </Dialog>
      )}
    </div>
  );
}
