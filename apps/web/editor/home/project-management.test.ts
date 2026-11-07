import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectHome } from "./ProjectHome";

it("can expose existing project management without the old creation dialog", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectHome, {
      session: {
        userId: "teacher",
        orgId: "school",
        role: "Educator",
        displayName: "Teacher",
        mustChangePassword: false,
      },
      active: true,
      onOpenProject: () => {},
      showCreation: false,
    }),
  );
  expect(html).toContain("Project status");
  expect(html).not.toContain("New project");
});
