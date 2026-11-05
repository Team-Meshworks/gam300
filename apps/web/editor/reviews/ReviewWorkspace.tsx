import { useEffect, useState } from "react";
import type { AccountSession } from "../accounts/account-client";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { allPages, createReviewClient, type ReviewClient } from "./review-client";
import type { Assignment, Classroom, Student } from "./review-types";
import { ProjectReview } from "./ProjectReview";
import "./reviews.css";

const client = createReviewClient();
export interface LeaveGuard {
  pending: boolean;
  dirty: boolean;
}
const emptyGuard: LeaveGuard = { pending: false, dirty: false };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Reviews could not be loaded.";

export function ReviewWorkspace({ session }: { session: AccountSession }) {
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [classId, setClassId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [guard, setGuard] = useState(emptyGuard);
  useEffect(() => {
    let disposed = false;
    allPages((cursor) => client.classrooms(cursor)).then(
      (rows) => {
        if (!disposed) {
          setClasses(rows);
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
  }, [attempt]);
  function canLeave() {
    return (
      !guard.pending &&
      (!guard.dirty || window.confirm("Discard your unsaved feedback or completion selection?"))
    );
  }
  return (
    <div className="sp-reviews">
      <p>
        {session.role === "Creator"
          ? "Submit a saved class project and read your educator’s feedback."
          : "Choose a class and student to review their submitted revision."}
      </p>
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
        <p role="status">Loading your classes…</p>
      ) : !error && classes.length === 0 ? (
        <p>No classes are available to your account.</p>
      ) : (
        <Field id="review-class" label="Class">
          <select
            id="review-class"
            value={classId}
            disabled={guard.pending || !!error}
            onChange={(e) => {
              if (canLeave()) {
                setGuard(emptyGuard);
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
          guard={guard}
          canLeave={canLeave}
          onGuard={setGuard}
        />
      )}
    </div>
  );
}

function ClassReviews({
  client,
  classId,
  className,
  session,
  guard,
  canLeave,
  onGuard,
}: {
  client: ReviewClient;
  classId: string;
  className: string;
  session: AccountSession;
  guard: LeaveGuard;
  canLeave: () => boolean;
  onGuard: (guard: LeaveGuard) => void;
}) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignmentId, setAssignmentId] = useState("");
  const [projectId, setProjectId] = useState("");
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
          onGuard={onGuard}
        />
      )}
    </div>
  );
}
