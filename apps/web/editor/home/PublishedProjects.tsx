import { useEffect, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { CreatorProjectCard } from "./CreatorProjectCard";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { readDashboardPublications, type StudentPublication } from "./student-publication";
import type { StudentProjectRow } from "./student-projects";

export function PublishedProjects({
  rows,
  session,
}: {
  rows: StudentProjectRow[];
  session: AccountSession;
}) {
  const [response, setResponse] = useState<{
    rows: StudentProjectRow[];
    links: Map<string, StudentPublication> | "error";
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readDashboardPublications(
      rows.map((row) => row.project.projectId),
      session.userId,
      controller.signal,
    ).then(
      (links) => {
        if (!controller.signal.aborted) setResponse({ rows, links });
      },
      () => {
        if (!controller.signal.aborted) setResponse({ rows, links: "error" });
      },
    );
    return () => controller.abort();
  }, [attempt, rows, session.userId]);
  const result = response?.rows === rows ? response.links : null;
  if (!result) return <DashboardSkeleton view="published" />;
  if (result === "error")
    return (
      <div className="sp-dashboard-state" role="alert">
        <p>Published projects could not be loaded. Try again.</p>
        <Button
          onClick={() => {
            setResponse(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (result.size === 0)
    return (
      <p className="sp-dashboard-state" role="status">
        No published projects are available yet.
      </p>
    );
  return (
    <div className="sp-student-list">
      {rows.map((row) => {
        const publication = result.get(row.project.projectId);
        return (
          publication && (
            <CreatorProjectCard
              key={publication.publicationId}
              row={row}
              name={session.displayName}
              publication={publication}
            />
          )
        );
      })}
    </div>
  );
}
