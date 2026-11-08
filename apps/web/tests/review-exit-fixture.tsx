import { createRoot } from "react-dom/client";
import { ProgressReviews } from "../editor/reviews/ProgressReviews";
import "../shared/ui/foundation.css";
import "../editor/reviews/reviews.css";
createRoot(document.getElementById("root")!).render(
  <ProgressReviews
    projectId="11111111-1111-4111-8111-111111111111"
    revision={7}
    actorId="22222222-2222-4222-8222-222222222222"
    orgId="44444444-4444-4444-8444-444444444444"
    educator
    autoOpen
    publication={{
      studentId: "33333333-3333-4333-8333-333333333333",
      studentName: "Student One",
      projectTitle: "Museum",
    }}
    onGuard={() => {}}
    onSaved={() => {
      document.body.dataset.saved = "yes";
    }}
  />,
);
