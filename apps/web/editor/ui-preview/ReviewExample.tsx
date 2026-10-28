import { useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faClipboardCheck } from "@fortawesome/free-solid-svg-icons";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";

export function ReviewExample({
  onPreview,
}: {
  onPreview: (title: string, body: ReactNode) => void;
}) {
  const [review, setReview] = useState("");
  return (
    <div className="sp-review-grid">
      <section className="sp-card sp-review-card">
        <div className="sp-between">
          <h2>Review submission</h2>
          <FontAwesomeIcon icon={faClipboardCheck} aria-hidden="true" />
        </div>
        <div>
          <h3>The Silk Road: A Journey Through History</h3>
          <p className="sp-hint">Class 4A · Aisyah · Completed and submitted</p>
        </div>
        <Field id="review" label="Your review">
          <textarea
            id="review"
            rows={4}
            value={review}
            onChange={(event) => setReview(event.target.value)}
            placeholder="Share what works well and what could be refined…"
          />
        </Field>
        <div className="sp-actions">
          <Button
            disabled={!review.trim()}
            onClick={() =>
              onPreview(
                "Review preview",
                <>
                  <p className="sp-example-note">Example only. This feedback has not been saved.</p>
                  <p>{review}</p>
                </>,
              )
            }
          >
            Preview review
          </Button>
          <Button variant="primary" disabled aria-describedby="approval-note">
            Approve to publish
          </Button>
        </div>
        <p className="sp-hint" id="approval-note">
          Approval will unlock publishing for the selected student’s submission. Approval is
          unavailable in this preview.
        </p>
      </section>
      <section className="sp-card">
        <h2>Class assignments</h2>
        <p className="sp-muted">Choose the students who should receive a project.</p>
        <a href="#classes">Open class assignments</a>
      </section>
    </div>
  );
}
