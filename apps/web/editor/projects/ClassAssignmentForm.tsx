import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUserPlus } from "@fortawesome/free-solid-svg-icons";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { ClassSelect } from "./ClassSelect";
import { StudentSelector } from "./StudentSelector";
import type { EligibleStudent, ProjectClass } from "./new-project-form";
import {
  validateClassAssignment,
  type AssignmentProject,
  type ClassAssignmentDraft,
  type ClassAssignmentResult,
} from "./class-assignment";
import "./class-assignment.css";

export function ClassAssignmentForm({
  projects,
  classes,
  students,
  onAssign,
  onAssigned,
}: {
  projects: readonly AssignmentProject[];
  classes: readonly ProjectClass[];
  students: readonly EligibleStudent[];
  onAssign?: (draft: ClassAssignmentDraft) => Promise<ClassAssignmentResult>;
  onAssigned?: (draft: ClassAssignmentDraft) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [classId, setClassId] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<"editing" | "pending" | "assigned" | "unknown">("editing");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);
  const project = projects.find((item) => item.id === projectId);
  const availableClasses = classes.filter((item) => project?.classIds.includes(item.id));
  const availableStudents = students.filter((student) => student.classIds.includes(classId));
  async function assign() {
    if (!onAssign || inFlight.current || phase !== "editing") return;
    const checked = validateClassAssignment(
      { projectId, classId, studentIds: selected },
      projects,
      classes,
      students,
    );
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError("");
    inFlight.current = true;
    setPhase("pending");
    let result: ClassAssignmentResult;
    try {
      result = await onAssign(checked.value);
    } catch {
      result = { kind: "unknown" };
    }
    if (!mounted.current) return;
    inFlight.current = false;
    if (result.kind === "rejected") {
      setPhase("editing");
      setError(result.message);
    } else if (result.kind === "assigned") {
      setPhase("assigned");
      try {
        onAssigned?.(checked.value);
      } catch {
        setError(
          "Assignment was confirmed, but the next view could not open. Check the project before assigning again.",
        );
      }
    } else {
      setPhase("unknown");
      setError(
        "Assignment outcome is unknown. Check the project before assigning again; your selection is still here.",
      );
    }
  }
  return (
    <form
      aria-label="Class assignment"
      aria-busy={phase === "pending"}
      onSubmit={(event) => {
        event.preventDefault();
        void assign();
      }}
    >
      {!onAssign && (
        <p className="sp-creation-notice" role="status">
          Class assignment is not connected yet. The roster and assignment backend is pending.
        </p>
      )}
      {error && (
        <p className="sp-creation-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      {phase === "pending" && (
        <p className="sp-creation-notice" role="status">
          Assigning students… Keep this page open.
        </p>
      )}
      {phase === "assigned" && (
        <p className="sp-creation-notice" role="status">
          Assignment confirmed for {selected.length}{" "}
          {selected.length === 1 ? "student" : "students"}.
        </p>
      )}
      <fieldset className="sp-project-fields" disabled={phase !== "editing"}>
        <legend className="sp-sr-only">Class assignment details</legend>
        <div className="sp-class-layout">
          <section className="sp-card sp-class-card">
            <h2>
              <FontAwesomeIcon icon={faUserPlus} aria-hidden="true" /> Assign to a class
            </h2>
            <p className="sp-muted">
              Choose a project and invite a class to start creating together.
            </p>
            <Field id="assignment-project" label="Project" required>
              <select
                id="assignment-project"
                required
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setClassId("");
                  setSelected([]);
                  setError("");
                }}
              >
                <option value="">Choose project</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </Field>
            <ClassSelect
              id="assignment-class"
              classes={availableClasses}
              value={classId}
              onChange={(value) => {
                setClassId(value);
                setSelected([]);
                setError("");
              }}
            />
            {!projects.length && (
              <p role="status" className="sp-hint">
                No projects are available for assignment.
              </p>
            )}
            {project && !availableClasses.length && (
              <p role="status" className="sp-hint">
                No classes are available for this project.
              </p>
            )}
            <p className="sp-hint">
              {selected.length} {selected.length === 1 ? "student" : "students"} selected. Only the
              selected students will be assigned.
            </p>
            <Button type="submit" disabled={!onAssign}>
              {phase === "pending" ? "Assigning…" : "Assign class"}
            </Button>
          </section>
          <div>
            {classId ? (
              <StudentSelector
                key={projectId + ":" + classId}
                students={availableStudents}
                selected={selected}
                onChange={setSelected}
              />
            ) : (
              <div className="sp-card sp-roster-placeholder" role="status">
                <h2>Class roster</h2>
                <p className="sp-muted">Choose a project and class to see available students.</p>
              </div>
            )}
          </div>
        </div>
      </fieldset>
    </form>
  );
}
