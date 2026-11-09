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
      <p className="sp-dashboard-state" role="status">
        No published projects are available yet.
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
