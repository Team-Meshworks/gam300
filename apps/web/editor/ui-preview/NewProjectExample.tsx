import { useState, type ReactNode } from "react";
import { NewProjectForm } from "../projects/NewProjectForm";
import type { NewProjectDraft, ProjectCreationResult } from "../projects/new-project-form";
import { Button } from "../../shared/ui/Button";
import { students } from "./fixtures";

const classes = [
  { id: "4A", label: "Class 4A" },
  { id: "4B", label: "Class 4B" },
];
const roster = students.map((student) => ({ ...student, classIds: [student.className] }));
type Outcome = "unavailable" | "success" | "rejected" | "unknown";

// Simulation remains in the development entry; the reusable form never imports fixtures
export function NewProjectExample({
  onPreview,
}: {
  onPreview: (title: string, body: ReactNode) => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>("unavailable");
  const [reset, setReset] = useState(0);
  const [created, setCreated] = useState(false);
  const [attempts, setAttempts] = useState(0);
  async function simulate(): Promise<ProjectCreationResult> {
    setAttempts((count) => count + 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (outcome === "success") return { kind: "created", projectId: "simulation-only" };
    if (outcome === "rejected")
      return {
        kind: "rejected",
        message: "Simulation: creation was rejected. Your details are unchanged.",
      };
    return { kind: "unknown" };
  }
  function preview(draft: NewProjectDraft) {
    onPreview(
      "Project preview",
      <>
        <p className="sp-example-note">Example only. No project has been created.</p>
        <h3>{draft.title}</h3>
        <p>{draft.description}</p>
        <p>{draft.instructions}</p>
        <dl className="sp-summary">
          <dt>Due date</dt>
          <dd>{draft.dueDate}</dd>
          <dt>Class</dt>
          <dd>{classes.find((item) => item.id === draft.classId)?.label}</dd>
          <dt>Image type</dt>
          <dd>{draft.imageType}</dd>
          <dt>Students</dt>
          <dd>
            {students
              .filter((student) => draft.studentIds.includes(student.id))
              .map((student) => student.name)
              .join(", ")}
          </dd>
        </dl>
      </>,
    );
  }
  return (
    <>
      <div className="sp-simulation-controls">
        <label>
          Submission outcome
          <select
            value={outcome}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "unavailable" ||
                value === "success" ||
                value === "rejected" ||
                value === "unknown"
              ) {
                setOutcome(value);
                setCreated(false);
                setAttempts(0);
              }
            }}
          >
            <option value="unavailable">Unavailable</option>
            <option value="success">Success</option>
            <option value="rejected">Rejected</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <Button
          onClick={() => {
            setReset((value) => value + 1);
            setCreated(false);
            setAttempts(0);
          }}
        >
          Reset simulation
        </Button>
        <span>Simulated requests: {attempts}</span>
        <p>Development controls only. No server requests or records are created.</p>
      </div>
      {created && (
        <p role="status" className="sp-creation-notice">
          Project created in simulation. The opening callback received the simulated ID; no real
          project exists.
        </p>
      )}
      <NewProjectForm
        key={outcome + reset}
        organizationName="Ridgeview Secondary School"
        creatorName="@MsTan"
        classes={classes}
        students={roster}
        onPreview={preview}
        {...(outcome !== "unavailable" ? { onSubmit: simulate } : {})}
        onCreated={() => setCreated(true)}
      />
    </>
  );
}
