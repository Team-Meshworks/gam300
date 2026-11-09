import { Icon } from "@iconify/react/offline";
import searchIcon from "@iconify-icons/ant-design/search-outlined";
import pencil from "@iconify-icons/lucide/pencil";
import clock from "@iconify-icons/lucide/clock-3";
import check from "@iconify-icons/lucide/circle-check";
import unknown from "@iconify-icons/lucide/circle-help";
import plus from "@iconify-icons/lucide/plus";
import { Button } from "../../shared/ui/Button";
import { SearchField } from "../../shared/ui/SearchField";
import { Tabs } from "../../shared/ui/Tabs";
import { DashboardSkeleton } from "./DashboardSkeleton";
import type { WorkStatus } from "./dashboard";
import neutralCover from "./assets/default-project-neutral.jpg";

const filters = [
  { value: "all", label: "All Projects" },
  { value: "pending", label: "Awaiting Approval" },
  { value: "progress", label: "In Progress" },
  { value: "complete", label: "Completed" },
] as const;
export type TeacherQuery = { search: string; filter: (typeof filters)[number]["value"] };
const statusIcons = {
  "In Progress": pencil,
  "Awaiting Approval": clock,
  Completed: check,
  "Status unavailable": unknown,
};
export type TeacherCard = {
  id: string;
  title: string;
  status: WorkStatus;
  metadata: string;
  onDetails: () => void;
};

export function TeacherDashboard({
  name,
  cards,
  error,
  onRetry,
  query,
  onQuery,
}: {
  name: string;
  cards: TeacherCard[] | null;
  error: string;
  onRetry: () => void;
  query: TeacherQuery;
  onQuery: (query: TeacherQuery) => void;
}) {
  const { filter, search } = query;
  const term = search.trim().toLocaleLowerCase();
  const matched = cards?.filter((card) => card.title.toLocaleLowerCase().includes(term));
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
            <p>Review published experiences and control what visitors can explore.</p>
          </div>
          <SearchField
            label="Search projects"
            placeholder="Search all projects"
            value={search}
            onChange={(search) => onQuery({ filter, search })}
            icon={<Icon icon={searchIcon} width={30} />}
          />
        </div>
        <div className="sp-teacher-toolbar">
          <Tabs
            id="facilitator-work"
            label="Filter projects by status"
            value={filter}
            onChange={(filter) => onQuery({ filter, search })}
            items={filters.map(({ value, label }) => ({
              value,
              label: matched
                ? `${label} (${value === "all" ? matched.length : matched.filter((card) => card.status === label).length})`
                : label,
            }))}
          />
          <a className="sp-button sp-button--primary sp-new-project" href="/new-project">
            <Icon icon={plus} width={13} /> New Project
          </a>
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
                : filter === "all"
                  ? "No projects are available yet."
                  : `No projects with status “${selectedLabel}”.`}
            </p>
          ) : (
            <div className="sp-teacher-grid">
              {shown.map((card) => (
                <article key={card.id} className="sp-teacher-card">
                  <img src={neutralCover} className="sp-teacher-card-cover" alt="" />
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
