import { useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { playUiSound } from "../audio/ui-sounds";
import { AccountList, type AccountActions } from "./AccountList";
import type { DirectoryOrganization } from "./directory";
import defaultProjectImage from "../home/assets/default-project-neutral.jpg";
import "./directory.css";

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Supply only organizations/accounts the current user is authorized to inspect
export function OrganizationDirectory({
  organizations,
  onPreview,
  selectedId,
  onSelect,
  onDelete,
  accountActions,
  loading,
  detailError,
  projectError,
}: {
  organizations: readonly DirectoryOrganization[];
  onPreview: (title: string, body: ReactNode) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete?: (id: string) => void;
  accountActions?: AccountActions;
  loading?: boolean;
  detailError?: string;
  projectError?: string;
}) {
  const [query, setQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const organization = organizations.find((item) => item.id === selectedId);
  if (organization)
    return (
      <div className="sp-directory">
        <div>
          <Button
            onClick={() => {
              onSelect(null);
              playUiSound("goingBack");
            }}
          >
            All organisations
          </Button>
        </div>
        <div className="sp-organization-detail">
          <div className="sp-organization-detail-left">
            <section className="sp-card sp-organization-identity">
              <div className="sp-account">
                <Avatar name={organization.name} />
                <h2>{organization.name}</h2>
              </div>
              <div className="sp-actions">
                <Button disabled title="Hiding organisations is not available yet">
                  Hide
                </Button>
                {onDelete && (
                  <Button
                    className="sp-button--danger"
                    aria-label="Delete organisation"
                    onClick={() => onDelete(organization.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              {!accountActions && (
                <dl className="sp-summary">
                  <dt>Projects</dt>
                  <dd>{organization.projects.length}</dd>
                  <dt>Teachers</dt>
                  <dd>{organization.accounts.filter((item) => item.role === "Teachers").length}</dd>
                  <dt>Students</dt>
                  <dd>{organization.accounts.filter((item) => item.role === "Students").length}</dd>
                </dl>
              )}
            </section>
            <section className="sp-card sp-organization-projects">
              <SearchField
                label="Search projects"
                value={projectQuery}
                onChange={setProjectQuery}
                placeholder="Search projects"
              />
              <h3>All Projects</h3>
              {loading && <p role="status">Loading organisation…</p>}
              {projectError && <p role="alert">{projectError}</p>}
              {organization.projects
                .filter((project) =>
                  project.title.toLowerCase().includes(projectQuery.trim().toLowerCase()),
                )
                .map((project) => (
                  <article className="sp-directory-project" key={project.id}>
                    <img src={project.cover || defaultProjectImage} alt="" />
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
              {!loading &&
                !projectError &&
                organization.projects.length > 0 &&
                !organization.projects.some((project) =>
                  project.title.toLowerCase().includes(projectQuery.trim().toLowerCase()),
                ) && <p role="status">No matching projects.</p>}
            </section>
          </div>
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
    <section className="sp-directory sp-organization-overview">
      <div className="sp-organization-overview-heading">
        <div>
          <h1>All Organisations</h1>
          <p className="sp-hint">Browse organisations and inspect their projects and accounts.</p>
        </div>
        <SearchField
          label="Search organisations"
          value={query}
          onChange={setQuery}
          placeholder="Search organisations by name"
        />
        <a
          className="sp-button sp-directory-close"
          href="/admin/dashboard"
          aria-label="Close organisations"
        >
          <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
        </a>
      </div>
      <h2>All Organisations</h2>
      <div className="sp-organization-grid">
        {visible.map((item) => (
          <article key={item.id} className="sp-card sp-organization-card">
            <div className="sp-account">
              <Avatar name={item.name} />
              <h3>{item.name}</h3>
            </div>
            {accountActions ? (
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
              variant="primary"
              aria-label={`Open ${item.name}`}
              onClick={() => {
                setProjectQuery("");
                onSelect(item.id);
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
