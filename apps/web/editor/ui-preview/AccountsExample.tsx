import { useState, type ReactNode } from "react";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Table } from "../../shared/ui/Table";
import { Tabs } from "../../shared/ui/Tabs";
import { accounts } from "./fixtures";

export function AccountsExample({
  onPreview,
}: {
  onPreview: (title: string, body: ReactNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"All" | "Students" | "Teachers">("All");
  const visible = accounts.filter(
    (account) =>
      (role === "All" || account.role === role) &&
      `${account.name} ${account.account}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="sp-card sp-directory">
      <div className="sp-directory-heading">
        <div className="sp-account">
          <Avatar name="Ridgeview" initials="R" />
          <div>
            <h2>Ridgeview Secondary School</h2>
            <p className="sp-hint">Account directory · sample organisation</p>
          </div>
        </div>
        <SearchField
          label="Search accounts"
          placeholder="Search by name or account"
          value={query}
          onChange={setQuery}
        />
      </div>
      <Tabs
        id="account-tabs"
        label="Account roles"
        value={role}
        onChange={setRole}
        items={[
          { value: "All", label: "All" },
          { value: "Students", label: "Students" },
          { value: "Teachers", label: "Teachers" },
        ]}
      />
      <div
        role="tabpanel"
        id="account-tabs-panel"
        aria-labelledby={`account-tabs-${role}`}
        tabIndex={0}
      >
        <Table caption="Organisation accounts" headings={["Account", "Role", "Status", "Details"]}>
          {visible.map((account) => (
            <tr key={account.id}>
              <th scope="row">
                <div className="sp-account">
                  <Avatar name={account.name} />
                  <span className="sp-person-name">
                    <strong>{account.name}</strong>
                    <small>{account.account}</small>
                  </span>
                </div>
              </th>
              <td>{account.role === "Students" ? "Student" : "Teacher"}</td>
              <td>
                <span
                  className={`sp-badge ${account.status === "Active" ? "sp-badge--success" : ""}`}
                >
                  {account.status}
                </span>
              </td>
              <td>
                <Button
                  aria-label={`View account for ${account.name}`}
                  onClick={() =>
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
                        <p className="sp-example-note">
                          Sample account. Account changes are unavailable in this preview.
                        </p>
                      </>,
                    )
                  }
                >
                  View Account
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {!visible.length && (
          <p className="sp-list-empty" role="status">
            No matching accounts. Try another name.
          </p>
        )}
      </div>
    </section>
  );
}
