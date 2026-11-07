import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProgressReviewList, ProgressReviews } from "./ProgressReviews";

describe("progress feedback presentation", () => {
  it("shows the feedback and dates in chronological order", () => {
    const markup = renderToStaticMarkup(
      createElement(ProgressReviewList, {
        items: [
          { id: "b", feedback: "Later feedback", revision: 2, createdAt: "2026-10-20T00:00:00Z" },
          { id: "a", feedback: "Earlier feedback", revision: 1, createdAt: "2026-10-18T00:00:00Z" },
        ],
      }),
    );
    expect(markup).toContain("Earlier feedback");
    expect(markup).toContain("Later feedback");
    expect(markup.indexOf("Earlier feedback")).toBeLessThan(markup.indexOf("Later feedback"));
    expect(markup).toContain("2026-10-18T00:00:00Z");
  });
});

it("opens the educator review dialog directly after returning from the editor", () => {
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
  expect(markup).toContain("Add Reviews");
});
