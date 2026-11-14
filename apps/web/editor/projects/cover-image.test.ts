import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NewProjectForm } from "./NewProjectForm";

it("offers a device image picker instead of a Gallery radio option", () => {
  const html = renderToStaticMarkup(
    createElement(NewProjectForm, {
      organizationName: "School",
      creatorName: "Teacher",
      classes: [],
      students: [],
    }),
  );
  expect(html).toContain('type="file"');
  expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
  expect(html).not.toContain('value="Gallery"');
});
