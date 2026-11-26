import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { formatLocalDeadline } from "./deadline";
import "./assignment-screens.css";
import { readAssignment, type AssignmentDetails } from "./assignment-api";

export function AssignmentDetailsScreen({
  classId,
  assignmentId,
  studentNames,
  onOpenProject,
  ownProject = false,
}: {
  classId: string;
  assignmentId: string;
  studentNames?: Record<string, string>;
  onOpenProject?: (projectId: string) => void;
  ownProject?: boolean;
}) {
  const key = `${classId}:${assignmentId}`;
  const [result, setResult] = useState<{
    key: string;
    details: AssignmentDetails | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void readAssignment(classId, assignmentId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key, details: value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, details: null });
      });
    return () => controller.abort();
  }, [classId, assignmentId, key]);
  if (!result || result.key !== key) return <LoadingSkeleton label="Loading assignment" />;
  if (!result.details)
    return <p role="alert">This assignment is unavailable for the current account.</p>;
  const details = result.details;
  return (
    <section aria-label="Assignment details" className="sp-assignment-details">
      <h2>{details.title}</h2>
      <p>{details.description}</p>
      <h3>Instructions</h3>
      <p>{details.instructions}</p>
      <p>Due: {formatLocalDeadline(details.dueAtUnixSeconds) ?? "Unavailable"}</p>
      {details.projects.map((project) => (
        <Button
          key={project.projectId}
          disabled={
            !onOpenProject ||
            (!ownProject && !(project.studentName ?? studentNames?.[project.studentId]))
          }
          onClick={() => onOpenProject?.(project.projectId)}
        >
          {ownProject
            ? "Open your project"
            : (project.studentName ?? studentNames?.[project.studentId])
              ? `Open project for ${project.studentName ?? studentNames?.[project.studentId]}`
              : "Student name unavailable"}
        </Button>
      ))}
      {!onOpenProject && (
        <p className="sp-hint">
          Opening projects is not available yet. You can read your assignment and instructions here.
        </p>
      )}
    </section>
  );
}
