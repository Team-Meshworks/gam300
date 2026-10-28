import { useState, type ReactNode } from "react";
import { SubmissionPanel } from "../projects/SubmissionPanel";
import type {
  Submission,
  SubmissionDraft,
  SubmissionResult,
  SubmissionState,
} from "../projects/submission";
import { Button } from "../../shared/ui/Button";
export function ReviewExample({
  onPreview,
}: {
  onPreview: (title: string, body: ReactNode) => void;
}) {
  const [outcome, setOutcome] = useState("unavailable");
  const [state, setState] = useState<SubmissionState>("submitted");
  const [reset, setReset] = useState(0);
  const [requests, setRequests] = useState(0);
  const [last, setLast] = useState("");
  const sample: Submission = {
    id: "sample-submission",
    revision: 1,
    title: "The Silk Road: A Journey Through History",
    student: "Aisyah",
    className: "4A",
    state,
  };
  async function simulate(draft: SubmissionDraft): Promise<SubmissionResult> {
    setRequests((value) => value + 1);
    setLast(`${draft.action} · ${draft.id} · revision ${draft.revision}`);
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (outcome === "rejected")
      return {
        kind: "rejected",
        message:
          "The simulated request was rejected. Your feedback has been kept; you can try again.",
      };
    if (outcome === "unknown") return { kind: "unknown" };
    return {
      kind: "confirmed",
      submission: {
        ...sample,
        state: (
          {
            complete: "completed",
            submit: "submitted",
            "save-review": "submitted",
            approve: "approved",
          } as const
        )[draft.action],
      },
    };
  }
  return (
    <>
      <div className="sp-simulation-controls">
        <label>
          Review outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {["unavailable", "success", "rejected", "unknown"].map((value) => (
              <option value={value} key={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Submission state
          <select value={state} onChange={(e) => setState(e.target.value as SubmissionState)}>
            {["editing", "completed", "submitted", "approved"].map((value) => (
              <option value={value} key={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => {
            setReset((value) => value + 1);
            setRequests(0);
            setLast("");
          }}
        >
          Reset review simulation
        </Button>
        <span>Simulated requests: {requests}</span>
        <p>
          Development simulation only. No real submission, review or approval is saved. Student and
          teacher panels demonstrate separate roles.
        </p>
        {last && <p>Last simulated request: {last}</p>}
      </div>
      <div className="sp-review-grid" key={`${outcome}:${state}:${reset}`}>
        <SubmissionPanel
          submission={sample}
          audience="teacher"
          {...(outcome === "unavailable" ? {} : { onAction: simulate })}
          onPreview={onPreview}
        />
        <SubmissionPanel
          submission={sample}
          audience="student"
          {...(outcome === "unavailable" ? {} : { onAction: simulate })}
        />
      </div>
    </>
  );
}
