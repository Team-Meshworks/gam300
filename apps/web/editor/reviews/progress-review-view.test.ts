import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProgressReviewList, ProgressReviews } from "./ProgressReviews";

describe("progress feedback presentation", () => {
  it("shows the feedback and dates in chronological order", () => {
    const markup = renderToStaticMarkup(
      createElement(ProgressReviewList, {
        items: [
          {
            id: "b",
            feedback: "Later feedback",
            revision: 2,
            createdAt: "2026-10-20T00:00:00Z",
          },
          {
            id: "a",
            feedback: "Earlier feedback",
            revision: 1,
            createdAt: "2026-10-18T00:00:00Z",
          },
        ],
      }),
    );
    expect(markup).toContain("Earlier feedback");
    expect(markup).toContain("Later feedback");
    expect(markup.indexOf("Earlier feedback")).toBeLessThan(markup.indexOf("Later feedback"));
    expect(markup).toContain("2026-10-18T00:00:00Z");
  });
  it("combines progress and submission feedback into one chronological history", () => {
    const markup = renderToStaticMarkup(
      createElement(ProgressReviewList, {
        items: [
          {
            id: "progress",
            feedback: "Second review",
            revision: 2,
            createdAt: "2026-10-20T09:15:00Z",
          },
        ],
        decisions: [
          {
            id: "decision",
            feedback: "First review",
            decidedAt: "2026-10-18T09:15:00Z",
          },
        ],
      }),
    );
    expect(markup).toContain("First review");
    expect(markup).toContain("Second review");
    expect(markup.indexOf("First review")).toBeLessThan(markup.indexOf("Second review"));
    expect(markup).toContain("2026-10-18T09:15:00Z");
    expect(markup).toContain("2026-10-20T09:15:00Z");
  });
});

it("opens saved educator feedback with add, cancel and save controls", () => {
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
  expect(markup).toContain("aria-labelledby=");
  expect(markup).toContain('aria-label="Add Reviews"');
  expect(markup).toContain("Save Changes");
  expect(markup).toContain(">Cancel<");
});
