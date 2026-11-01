import { useState } from "react";
import { ClassAssignmentForm } from "../projects/ClassAssignmentForm";
import type { ClassAssignmentDraft, ClassAssignmentResult } from "../projects/class-assignment";
import { Button } from "../../shared/ui/Button";
import { students } from "./fixtures";

const classes = [
  { id: "4A", label: "Class 4A" },
  { id: "4B", label: "Class 4B" },
];
const projects = [
  { id: "silk-road", title: "The Silk Road: A Journey Through History", classIds: ["4A", "4B"] },
  { id: "natural-world", title: "Our Natural World", classIds: ["4A", "4B"] },
];
const roster = students.map((student) => ({ ...student, classIds: [student.className] }));
type Outcome = "unavailable" | "success" | "rejected" | "unknown";

export function ClassAssignmentExample() {
  const [outcome, setOutcome] = useState<Outcome>("unavailable");
  const [reset, setReset] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [receipt, setReceipt] = useState<ClassAssignmentDraft | null>(null);
  async function simulate(): Promise<ClassAssignmentResult> {
    setAttempts((count) => count + 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (outcome === "success") return { kind: "assigned" };
    if (outcome === "rejected")
      return {
        kind: "rejected",
        message: "Simulation: assignment was rejected. Your selection is unchanged.",
      };
    return { kind: "unknown" };
  }
  return (
    <>
      <div className="sp-simulation-controls">
        <label>
          Assignment outcome
          <select
            value={outcome}
            onChange={(event) => {
              const next = event.target.value;
              if (
                next === "unavailable" ||
                next === "success" ||
                next === "rejected" ||
                next === "unknown"
              ) {
                setOutcome(next);
                setReceipt(null);
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
            setReceipt(null);
            setAttempts(0);
          }}
        >
          Reset assignment simulation
        </Button>
        <span>Simulated assignments: {attempts}</span>
        <p>Development controls only. No students or projects are changed.</p>
      </div>
      {receipt && (
        <section className="sp-creation-notice" role="status">
          <h2>Assigned in simulation</h2>
          <p>{projects.find((project) => project.id === receipt.projectId)?.title}</p>
          <p>{classes.find((item) => item.id === receipt.classId)?.label}</p>
          <p>
            {students
              .filter((student) => receipt.studentIds.includes(student.id))
              .map((student) => student.name)
              .join(", ")}
          </p>
          <p>No real assignment or student draft was created.</p>
        </section>
      )}
      <ClassAssignmentForm
        key={outcome + reset}
        projects={projects}
        classes={classes}
        students={roster}
        {...(outcome !== "unavailable" ? { onAssign: simulate } : {})}
        onAssigned={setReceipt}
      />
    </>
  );
}
