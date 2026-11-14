import { Icon } from "@iconify/react/offline";
import pencil from "@iconify-icons/lucide/pencil";
import clock from "@iconify-icons/lucide/clock-3";
import check from "@iconify-icons/lucide/circle-check";
import unknown from "@iconify-icons/lucide/circle-help";
import plus from "@iconify-icons/lucide/plus";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Select } from "../../shared/ui/Select";
import { Tabs } from "../../shared/ui/Tabs";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { projectCover, type WorkStatus } from "./dashboard";

const filters = [
  { value: "all", label: "All Projects" },
  { value: "pending", label: "Awaiting Approval" },
  { value: "progress", label: "In Progress" },
  { value: "complete", label: "Completed" },
] as const;
export type TeacherQuery = {
  search: string;
  filter: (typeof filters)[number]["value"];
  classId: string;
};
const statusIcons = {
  "In Progress": pencil,
  "Awaiting Approval": clock,
  Completed: check,
  "Status unavailable": unknown,
};
export type TeacherCard = {
  id: string;
  classId?: string;
  title: string;
  status: WorkStatus;
  metadata: string;
  imageUrl?: string;
  onDetails: () => void;
};

export function TeacherDashboard({
  name,
  cards,
  classes,
  error,
  onRetry,
  query,
  onQuery,
}: {
  name: string;
  cards: TeacherCard[] | null;
  classes: readonly { id: string; name: string }[];
  error: string;
  onRetry: () => void;
  query: TeacherQuery;
  onQuery: (query: TeacherQuery) => void;
}) {
  const { filter, search, classId } = query;
  const term = search.trim().toLocaleLowerCase();
  const matched = cards?.filter(
    (card) =>
      (!classId || card.classId === classId) && card.title.toLocaleLowerCase().includes(term),
  );
  const selectedLabel = filters.find((item) => item.value === filter)?.label;
  const shown = matched?.filter((card) => filter === "all" || card.status === selectedLabel);
  return (
    <>
      <div className="sp-teacher-welcome">
        <h1>Welcome Back, {name}</h1>
        <p>A space to spark ideas, guide student work and curate what gets shared.</p>
      </div>
      <section className="sp-teacher-projects" aria-labelledby="facilitator-heading">
        <div className="sp-teacher-heading">
          <div>
            <h2 id="facilitator-heading">All Projects</h2>
            <p>Review student progress and manage project visibility.</p>
          </div>
          <SearchField
            label="Search projects"
            placeholder="Search all projects"
            value={search}
            onChange={(search) => onQuery({ ...query, search })}
          />
        </div>
        <div className="sp-teacher-toolbar">
          <Tabs
            id="facilitator-work"
            label="Filter projects by status"
            value={filter}
            onChange={(filter) => onQuery({ ...query, filter })}
            items={filters.map(({ value, label }) => ({
              value,
              label: matched
                ? `${label} (${value === "all" ? matched.length : matched.filter((card) => card.status === label).length})`
                : label,
            }))}
          />
          <div className="sp-teacher-toolbar-actions">
            <Select
              label="Filter projects by class"
              value={classId}
              options={[
                { value: "", label: "All Classes" },
                ...[...classes]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(({ id, name }) => ({ value: id, label: name })),
              ]}
              disabled={!cards}
              onChange={(classId) => onQuery({ ...query, classId })}
              className="sp-project-class sp-teacher-class-filter"
              menuClassName="sp-project-class-menu sp-teacher-class-menu"
            />
            <a className="sp-button sp-button--primary sp-new-project" href="/new-project">
              <Icon icon={plus} width={13} /> New Project
            </a>
          </div>
        </div>
        <div
          id="facilitator-work-panel"
          role="tabpanel"
          aria-labelledby={`facilitator-work-${filter}`}
        >
          {error ? (
            <div className="sp-dashboard-state" role="alert">
              <p>{error}</p>
              <Button onClick={onRetry}>Retry</Button>
            </div>
          ) : !shown ? (
            <DashboardSkeleton view="facilitator" />
          ) : !shown.length ? (
            <p className="sp-dashboard-state" role="status">
              {term
                ? "No projects match your search."
                : filter === "all" && !classId
                  ? "No projects are available yet."
                  : classId
                    ? "No projects match this class and status."
                    : `No projects with status “${selectedLabel}”.`}
            </p>
          ) : (
            <div className="sp-teacher-grid">
              {shown.map((card) => (
                <article key={card.id} className="sp-teacher-card">
                  <img
                    src={card.imageUrl ?? projectCover(card.title)}
                    className="sp-teacher-card-cover"
                    alt=""
                  />
                  <div className="sp-teacher-card-copy">
                    <div className="sp-teacher-card-heading">
                      <h3>{card.title}</h3>
                      <span className="sp-work-status" data-state={card.status}>
                        <Icon icon={statusIcons[card.status]} width={13} />
                        {card.status}
                      </span>
                    </div>
                    <p>{card.metadata}</p>
                    <Button
                      variant="primary"
                      id={`teacher-project-${card.id}`}
                      onClick={card.onDetails}
                    >
                      View Details
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
