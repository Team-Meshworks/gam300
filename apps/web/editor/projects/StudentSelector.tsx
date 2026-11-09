import { useId, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUsers } from "@fortawesome/free-solid-svg-icons";
import { Avatar } from "../../shared/ui/Avatar";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { Button } from "../../shared/ui/Button";
import type { EligibleStudent } from "./new-project-form";
import "./new-project.css";

export function StudentSelector({
  students: available,
  selected,
  onChange,
  emptyMessage = "No matching students.",
}: {
  students: readonly EligibleStudent[];
  selected: readonly string[];
  onChange: (ids: readonly string[]) => void;
  emptyMessage?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "selected">("all");
  const selectedIds = new Set(selected);
  const search = query.trim().toLowerCase();
  const visible = available.filter(
    (student) =>
      (student.name + " " + student.account).toLowerCase().includes(search) &&
      (tab === "all" || selectedIds.has(student.id)),
  );
  return (
    <section className="sp-students" aria-labelledby={`${id}-heading`}>
      <div className="sp-students-header">
        <div className="sp-between">
          <h2 id={`${id}-heading`}>Add students</h2>
          <span className="sp-badge" role="status">
            {selected.length} selected
          </span>
        </div>
        <p className="sp-muted">Choose the students who will receive this project.</p>
        <SearchField
          label="Search students"
          placeholder="Search students by name or account"
          value={query}
          onChange={setQuery}
        />
        <div className="sp-between sp-student-filters">
          <Tabs
            id={`${id}-tabs`}
            label="Student selection"
            value={tab}
            onChange={setTab}
            items={[
              { value: "all", label: `All students (${available.length})` },
              { value: "selected", label: `Selected (${selected.length})` },
            ]}
          />
          <Button
            variant="quiet"
            disabled={!visible.length}
            onClick={() =>
              onChange([...new Set([...selected, ...visible.map((student) => student.id)])])
            }
          >
            Select all
          </Button>
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-tabs-panel`}
        aria-labelledby={`${id}-tabs-${tab}`}
        tabIndex={0}
      >
        <ul className="sp-person-list">
          {visible.map((student) => (
            <li key={student.id}>
              <label className="sp-person-row">
                <input
                  type="checkbox"
                  checked={selectedIds.has(student.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, student.id]
                        : selected.filter((id) => id !== student.id),
                    )
                  }
                />
                <Avatar name={student.name} />
                <span className="sp-person-name">
                  <strong>{student.name}</strong>
                  <small>{student.account}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {!visible.length && (
          <p className="sp-list-empty" role="status">
            {tab === "selected" && !selected.length
              ? "No students selected yet."
              : search
                ? "No matching students."
                : emptyMessage}
          </p>
        )}
      </div>
      <p className="sp-students-footer">
        <FontAwesomeIcon icon={faUsers} aria-hidden="true" />
        <span>
          Select students using the checkboxes above. Only students available in the selected class
          can be assigned.
        </span>
      </p>
    </section>
  );
}
