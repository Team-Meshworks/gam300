import { useEffect, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import type { LeaveGuard } from "../workspace/useWorkspaceDeparture";
import { isId } from "../home/workspace-api";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { allPages, createReviewClient, type ReviewClient } from "./review-client";
import type { Assignment, Classroom, Student } from "./review-types";
import { ProjectReview } from "./ProjectReview";
import "./reviews.css";

const client = createReviewClient();
const emptyGuard: LeaveGuard = { pending: false, dirty: false };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Reviews could not be loaded.";

export function ReviewWorkspace({
  session,
  guard,
  onGuard,
}: {
  session: AccountSession;
  guard: LeaveGuard;
  onGuard: (guard: LeaveGuard) => void;
}) {
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [classId, setClassId] = useState("");
  const [linkedProject, setLinkedProject] = useState<{
    assignmentId: string;
    projectId: string;
  } | null>(null);
  const [linkError, setLinkError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const rows = await allPages((cursor) => client.classrooms(cursor));
        if (disposed) return;
        setClasses(rows);
        const ids = new URLSearchParams(location.search).getAll("projectId");
        if (ids.length) {
          try {
            if (ids.length !== 1 || !isId(ids[0])) throw new Error("The review link is invalid.");
            const target = await client.projectAssignment(ids[0]);
            if (disposed) return;
            if (!rows.some((row) => row.id === target.classId))
              throw new Error("The linked class is unavailable to your account.");
            setLinkedProject(target);
            setClassId(target.classId);
          } catch (failure) {
            if (!disposed) setLinkError(message(failure));
          }
        }
      } catch (failure) {
        if (!disposed) setError(message(failure));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [attempt]);
  function canLeave() {
    return (
      !guard.pending &&
      (!guard.dirty || window.confirm("Discard your unsaved feedback or completion selection?"))
    );
  }
  return (
    <section className="sp-review-workspace" aria-label="Submissions and reviews">
      <div className="sp-page-heading">
        <h1>Submission review</h1>
        <p>
          {session.role === "Creator"
            ? "Submit a saved class project and read your educator’s feedback."
            : "Choose a class and student to review their submitted revision."}
        </p>
      </div>
      <div className="sp-reviews">
        {linkError && <p role="alert">{linkError}</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button
              onClick={() => {
                setError("");
                setLoading(true);
                setAttempt((a) => a + 1);
              }}
            >
              Retry class list
            </Button>
          </div>
        )}
        {loading ? (
          <p className="sp-list-empty" role="status">
            Loading your classes…
          </p>
        ) : !error && classes.length === 0 ? (
          <p className="sp-list-empty" role="status">
            No classes are available to your account.
          </p>
        ) : (
          <Field id="review-class" label="Class">
            <select
              id="review-class"
              value={classId}
              disabled={guard.pending || !!error}
              onChange={(e) => {
                if (canLeave()) {
                  setLinkedProject(null);
                  setLinkError("");
                  onGuard(emptyGuard);
                  setClassId(e.target.value);
                }
              }}
            >
              <option value="">Choose a class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {classId && (
          <ClassReviews
            key={classId}
            client={client}
            classId={classId}
            session={session}
            className={classes.find((c) => c.id === classId)?.name ?? ""}
            linkedProject={linkedProject}
            guard={guard}
            canLeave={canLeave}
            onGuard={onGuard}
          />
        )}
      </div>
    </section>
  );
}

function ClassReviews({
  client,
  classId,
  className,
  linkedProject,
  session,
  guard,
  canLeave,
  onGuard,
}: {
  client: ReviewClient;
  classId: string;
  className: string;
  linkedProject: { assignmentId: string; projectId: string } | null;
  session: AccountSession;
  guard: LeaveGuard;
  canLeave: () => boolean;
  onGuard: (guard: LeaveGuard) => void;
}) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignmentId, setAssignmentId] = useState(linkedProject?.assignmentId ?? "");
  const [projectId, setProjectId] = useState(linkedProject?.projectId ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    Promise.all([
      allPages((cursor) => client.assignments(classId, cursor)),
      session.role === "Educator"
        ? allPages((cursor) => client.roster(classId, cursor))
        : Promise.resolve([]),
    ]).then(
      ([items, roster]) => {
        if (!disposed) {
          setAssignments(items);
          setStudents(roster);
          setLoading(false);
        }
      },
      (failure) => {
        if (!disposed) {
          setError(message(failure));
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [client, classId, session.role, attempt]);
  const selected = assignments.find((a) => a.assignmentId === assignmentId);
  const projects =
    selected?.projects.filter(
      (p) => session.role === "Educator" || p.studentId === session.userId,
    ) ?? [];
  const selectedProject = projects.find((p) => p.projectId === projectId);
  const studentName = (studentId: string) =>
    session.role === "Creator"
      ? session.displayName
      : (students.find((s) => s.userId === studentId)?.userName ?? "Student " + studentId);
  return (
    <div className="sp-reviews">
      {loading && <p role="status">Loading assignments…</p>}
      {!loading && !error && projectId && !selectedProject && (
        <p role="alert">This project is no longer available in the selected assignment.</p>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button
            onClick={() => {
              setError("");
              setLoading(true);
              setAttempt((a) => a + 1);
            }}
          >
            Retry assignments
          </Button>
        </div>
      )}
      {!loading &&
        !error &&
        (assignments.length === 0 ? (
          <p>No assignments are available in this class.</p>
        ) : (
          <Field id="review-assignment" label="Assignment">
            <select
              id="review-assignment"
              value={assignmentId}
              disabled={guard.pending}
              onChange={(e) => {
                if (canLeave()) {
                  onGuard(emptyGuard);
                  setAssignmentId(e.target.value);
                  setProjectId("");
                }
              }}
            >
              <option value="">Choose an assignment</option>
              {assignments.map((a) => (
                <option key={a.assignmentId} value={a.assignmentId}>
                  {a.title}
                </option>
              ))}
            </select>
          </Field>
        ))}
      {selected && (
        <Field
          id="review-student"
          label={session.role === "Creator" ? "Your assigned project" : "Student project"}
        >
          <select
            id="review-student"
            disabled={guard.pending}
            value={projectId}
            onChange={(e) => {
              if (canLeave()) {
                onGuard(emptyGuard);
                setProjectId(e.target.value);
              }
            }}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {studentName(p.studentId)} · {selected.title}
              </option>
            ))}
          </select>
          {projects.length === 0 && <p>No student projects are available to your account.</p>}
        </Field>
      )}
      {selectedProject && (
        <ProjectReview
          key={projectId}
          client={client}
          projectId={projectId}
          studentId={selectedProject.studentId}
          studentName={studentName(selectedProject.studentId)}
          className={className}
          role={session.role}
          actorId={session.userId}
          orgId={session.orgId}
          onGuard={onGuard}
        />
      )}
    </div>
  );
}
