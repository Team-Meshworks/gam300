import { useState, type ReactNode } from "react";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { AccountList, type AccountActions } from "./AccountList";
import type { DirectoryOrganization } from "./directory";
import "./directory.css";

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Supply only organizations/accounts the current user is authorized to inspect
export function OrganizationDirectory({
  organizations,
  onPreview,
  onSelect,
  accountActions,
  loading,
  detailError,
  projectError,
}: {
  organizations: readonly DirectoryOrganization[];
  onPreview: (title: string, body: ReactNode) => void;
  onSelect?: (id: string | null) => void;
  accountActions?: AccountActions;
  loading?: boolean;
  detailError?: string;
  projectError?: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const organization = organizations.find((item) => item.id === selected);
  if (organization)
    return (
      <div className="sp-directory">
        <div>
          <Button
            onClick={() => {
              setSelected(null);
              onSelect?.(null);
            }}
          >
            All organisations
          </Button>
        </div>
        <div className="sp-organization-detail">
          <section className="sp-card sp-directory">
            <div className="sp-account">
              <Avatar name={organization.name} />
              <h2>{organization.name}</h2>
            </div>
            <p>{organization.description}</p>
            {!onSelect && (
              <dl className="sp-summary">
                <dt>Projects</dt>
                <dd>{organization.projects.length}</dd>
                <dt>Teachers</dt>
                <dd>{organization.accounts.filter((item) => item.role === "Teachers").length}</dd>
                <dt>Students</dt>
                <dd>{organization.accounts.filter((item) => item.role === "Students").length}</dd>
              </dl>
            )}
            <h3>Projects</h3>
            {loading && <p role="status">Loading organisation…</p>}
            {projectError && <p role="alert">{projectError}</p>}
            {organization.projects.map((project) => (
              <article className="sp-directory-project" key={project.id}>
                {project.cover && <img src={project.cover} alt="" />}
                <div>
                  <h4>{project.title}</h4>
                  <p className="sp-hint">
                    {project.creator ? `${project.creator} · ` : ""}
                    {project.status}
                  </p>
                  <Button
                    onClick={() =>
                      onPreview(
                        "Project details",
                        <>
                          <h3>{project.title}</h3>
                          {project.creator && <p>Creator: {project.creator}</p>}
                          <p>Status: {project.status}</p>
                          <p className="sp-hint">
                            Read-only directory details. Project editing and publication are
                            unavailable here.
                          </p>
                        </>,
                      )
                    }
                  >
                    View project
                  </Button>
                </div>
              </article>
            ))}
            {!loading && !projectError && !organization.projects.length && (
              <p role="status">No projects in this organisation.</p>
            )}
          </section>
          <AccountList
            key={organization.id}
            accounts={organization.accounts}
            organizationName={organization.name}
            onPreview={onPreview}
            actions={accountActions}
            loading={Boolean(loading)}
            error={detailError}
          />
        </div>
      </div>
    );
  const visible = organizations.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <section className="sp-directory">
      <h2>Organisations</h2>
      <p className="sp-hint">Browse organisations and inspect their projects and accounts.</p>
      <SearchField
        label="Search organisations"
        value={query}
        onChange={setQuery}
        placeholder="Search organisations by name"
      />
      <div className="sp-organization-grid">
        {visible.map((item) => (
          <article key={item.id} className="sp-card sp-organization-card">
            <div className="sp-account">
              <Avatar name={item.name} />
              <h3>{item.name}</h3>
            </div>
            {onSelect ? (
              <p className="sp-hint">{item.description}</p>
            ) : (
              <p className="sp-hint">
                {countLabel(item.projects.length, "project")} ·{" "}
                {countLabel(
                  item.accounts.filter((account) => account.role === "Teachers").length,
                  "teacher",
                )}{" "}
                ·{" "}
                {countLabel(
                  item.accounts.filter((account) => account.role === "Students").length,
                  "student",
                )}
              </p>
            )}
            <Button
              aria-label={`Open ${item.name}`}
              onClick={() => {
                setSelected(item.id);
                onSelect?.(item.id);
              }}
            >
              View Organisation
            </Button>
          </article>
        ))}
      </div>
      {!visible.length && <p role="status">No matching organisations. Try another name.</p>}
    </section>
  );
}
