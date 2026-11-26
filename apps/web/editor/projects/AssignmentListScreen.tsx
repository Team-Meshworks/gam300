import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { Table } from "../../shared/ui/Table";
import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { formatLocalDeadline } from "./deadline";
import "./assignment-screens.css";
import { listAssignments, type AssignmentDetails } from "./assignment-api";
import { AssignmentDetailsScreen } from "./AssignmentDetailsScreen";

export function AssignmentListScreen({
  classId,
  onOpenProject,
  studentNames,
  ownProject = false,
  onOpenAssignment,
}: {
  classId: string;
  onOpenProject?: (projectId: string) => void;
  studentNames?: Record<string, string>;
  ownProject?: boolean;
  onOpenAssignment?: (assignmentId: string) => void;
}) {
  const [result, setResult] = useState<{
    classId: string;
    items: AssignmentDetails[] | null;
  } | null>(null);
  const [selected, setSelected] = useState<{
    classId: string;
    assignmentId: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void listAssignments(classId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setResult({ classId, items });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ classId, items: null });
      });
    return () => controller.abort();
  }, [classId]);
  if (selected?.classId === classId)
    return (
      <>
        <Button onClick={() => setSelected(null)}>Back to assignments</Button>
        <AssignmentDetailsScreen
          key={selected.assignmentId}
          classId={classId}
          assignmentId={selected.assignmentId}
          ownProject={ownProject}
          {...(studentNames ? { studentNames } : {})}
          {...(onOpenProject ? { onOpenProject } : {})}
        />
      </>
    );
  if (!result || result.classId !== classId) return <LoadingSkeleton label="Loading assignments" />;
  if (!result.items)
    return <p role="alert">Assignments are unavailable for the current account.</p>;
  if (!result.items.length) return <p role="status">No assignments are available.</p>;
  if (onOpenAssignment)
    return (
      <section aria-label="Class assignments" className="sp-organisation-projects">
        <h2>Class Projects</h2>
        <Table caption="Projects in this class" headings={["Project", "Due Date", "Actions"]}>
          {result.items.map((item) => (
            <tr key={item.assignmentId}>
              <th scope="row">{item.title}</th>
              <td title={formatLocalDeadline(item.dueAtUnixSeconds) ?? "Unavailable"}>
                {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(
                  new Date(item.dueAtUnixSeconds * 1000),
                )}
              </td>
              <td>
                <Button onClick={() => onOpenAssignment(item.assignmentId)}>View Details</Button>
              </td>
            </tr>
          ))}
        </Table>
      </section>
    );

  return (
    <section aria-label="Class assignments">
      <h2>Assignments</h2>
      <ul className="sp-assignment-list">
        {result.items.map((item) => (
          <li key={item.assignmentId}>
            <Button onClick={() => setSelected({ classId, assignmentId: item.assignmentId })}>
              {item.title}
            </Button>
            <span> Due: {formatLocalDeadline(item.dueAtUnixSeconds) ?? "Unavailable"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
