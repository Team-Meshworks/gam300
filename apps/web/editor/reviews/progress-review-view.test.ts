import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProgressReviewList, ProgressReviews } from "./ProgressReviews";

it("shows dated progress and submission feedback in one chronological history", () => {
  const markup = renderToStaticMarkup(
    createElement(ProgressReviewList, {
      items: [
        {
          id: "later",
          feedback: "Later progress",
          revision: 2,
          createdAt: "2026-10-20T09:15:00Z",
        },
        {
          id: "earlier",
          feedback: "Earlier progress",
          revision: 1,
          createdAt: "2026-10-18T09:15:00Z",
        },
      ],
      decisions: [
        {
          id: "decision",
          feedback: "Submission feedback",
          decidedAt: "2026-10-19T09:15:00Z",
        },
      ],
    }),
  );
  expect(markup).toMatch(/Earlier progress.*Submission feedback.*Later progress/s);
  expect(markup).toContain('dateTime="2026-10-18T09:15:00Z"');
  expect(markup).toContain('dateTime="2026-10-19T09:15:00Z"');
  expect(markup).toContain('dateTime="2026-10-20T09:15:00Z"');
});

it("keeps the automatic educator review dialog closed before history arrives", () => {
  const markup = renderToStaticMarkup(
    createElement(ProgressReviews, {
      projectId: "11111111-1111-4111-8111-111111111111",
      revision: 2,
      actorId: "22222222-2222-4222-8222-222222222222",
      educator: true,
      onGuard: () => {},
      autoOpen: true,
      onClose: () => {},
    }),
  );
  expect(markup).toBe("");
});
