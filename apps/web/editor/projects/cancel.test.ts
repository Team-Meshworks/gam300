import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NewProjectForm } from "./NewProjectForm";

it("offers Cancel instead of a destructive form reset", () => {
  const html = renderToStaticMarkup(
    createElement(NewProjectForm, {
      organizationName: "School",
      creatorName: "Teacher",
      classes: [],
      students: [],
    }),
  );
  expect(html).toContain("Cancel</button>");
  expect(html).not.toContain("Clear form");
  expect(html).not.toContain('type="reset"');
});
