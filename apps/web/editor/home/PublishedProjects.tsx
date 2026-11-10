import { CreatorProjectCard } from "./CreatorProjectCard";
import type { StudentPublication } from "./student-publication";
import type { StudentProjectRow } from "./student-projects";

export function PublishedProjects({
  rows,
  links,
  name,
}: {
  rows: StudentProjectRow[];
  links: ReadonlyMap<string, StudentPublication>;
  name: string;
}) {
  if (!rows.some((row) => links.has(row.project.projectId)))
    return (
      <p className="sp-dashboard-state sp-publications-empty" role="status">
        <svg
          className="sp-publications-illustration"
          viewBox="0 0 160 120"
          fill="none"
          aria-hidden="true"
        >
          <rect x="20" y="24" width="94" height="68" rx="12" className="sp-publications-back" />
          <rect x="42" y="35" width="98" height="70" rx="12" className="sp-publications-front" />
          <path d="M66 87h50M73 80V63m12 17V63m12 17V63m12 17V63M68 59l23-12 23 12H68Z" />
          <path d="M126 15v12m-6-6h12M26 102v8m-4-4h8" className="sp-publications-accent" />
        </svg>
        <span className="sp-sr-only">No published projects are available yet.</span>
      </p>
    );
  return (
    <div className="sp-student-list">
      {rows.map((row) => {
        const publication = links.get(row.project.projectId);
        return (
          publication && (
            <CreatorProjectCard
              key={publication.publicationId}
              row={row}
              name={name}
              publication={publication}
            />
          )
        );
      })}
    </div>
  );
}
