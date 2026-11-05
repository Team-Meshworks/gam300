import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Viewpoints } from "./Viewpoints";
import { createDocumentStore } from "./document-store";

it("keeps Saved Views controls in their original styling", () => {
  const markup = renderToStaticMarkup(
    createElement(Viewpoints, {
      views: [],
      camera: null,
      disabled: true,
      store: createDocumentStore([]),
      startCamera: { position: [0, 1, 3], rotation: [0, 0, 0, 1], fovDegrees: 60 },
    }),
  );
  expect(markup).toContain("Capture current view");
  expect(markup).toContain('class="saved-view-toggle"');
  expect(markup).not.toContain("panel-pill");
  expect(markup).not.toContain("panel-input");
});
