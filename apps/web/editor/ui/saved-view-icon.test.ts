import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Icon } from "./Icon";

it("renders Saved views with its decorative Figma SVG export", () => {
  const markup = renderToStaticMarkup(createElement(Icon, { name: "savedView" }));
  expect(markup).toContain('class="figma-tool-icon"');
  expect(markup).toContain("saved-views.svg");
  expect(markup).toContain('alt=""');
  expect(markup).toContain('aria-hidden="true"');
});
