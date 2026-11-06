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
  const [organizations, setOrganizations] = useState<ManagedOrganization[]>([]);
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
  const [deleting, setDeleting] = useState<string | null>(null);
  const pending = useRef(false);
  const selection = useRef(selected);
  useEffect(() => {
    let disposed = false;
    void client.organizations().then(
      (items) => {
        if (!disposed) {
          setOrganizations(items);
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
    return () => {
      disposed = true;
    };
  }, [attempt, client]);
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
      setNotice(toggle.isActive ? "Account disabled." : "Account enabled.");
      setToggle(null);
    } catch (reason) {
      setNotice(message(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const organization = organizations.find((row) => row.id === selected);
  if (loading) return <p role="status">Loading organisations…</p>;
  if (error)
    return (
      <div>
        <p role="alert">{error}</p>
        <Button onClick={refresh}>Retry</Button>
      </div>
    );
  return (
    <div className="sp-directory">
      <div className="sp-directory-heading">
        <p className="sp-hint">Manage accounts within an organisation.</p>
        <Button onClick={refresh} disabled={busy || detailLoading}>
          Refresh directory
        </Button>
      </div>
      {notice && <p role="status">{notice}</p>}
      <OrganizationDirectory
        organizations={organizations.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.isActive ? "Active organisation" : "Inactive organisation",
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
        loading={detailLoading}
        detailError={detailError}
        projectError={projectError}
        onPreview={(title, body) => setPreview({ title, body })}
        accountActions={{
          onCreate: () => setModal("create"),
          onView: (id) => void view(id),
          onToggleActive: (id) => setToggle(accounts.find((row) => row.userId === id) ?? null),
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
            setOrganizations((items) => items.filter((item) => item.id !== deleting));
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
        <Dialog title={preview.title} onClose={() => setPreview(null)}>
          {preview.body}
        </Dialog>
      )}
      {toggle && (
        <Dialog
          title={`${toggle.isActive ? "Disable" : "Enable"} account`}
          onClose={() => {
            if (!pending.current) setToggle(null);
          }}
        >
          <p>
            {toggle.isActive
              ? `${toggle.displayName} will lose access and be signed out. Their projects and history will be kept.`
              : `${toggle.displayName} will be able to sign in when their organisation is active.`}
          </p>
          <div className="sp-actions">
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
