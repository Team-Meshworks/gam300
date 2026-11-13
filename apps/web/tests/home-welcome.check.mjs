import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const origin = process.argv[2] ?? "http://127.0.0.1:5182";
const browser = await launchBrowser({ target: origin });
try {
  for (const [role, welcome] of [
    ["Educator", "Welcome Back, Teacher"],
    ["Creator", "Projects"],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(7000);
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/auth/session")
        return route.fulfill({
          json: {
            userId: "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e",
            orgId: "ef580108-e406-4c8e-ac76-75cd41e9d2dc",
            role,
            displayName: role === "Educator" ? "Teacher" : "Student",
            mustChangePassword: false,
          },
        });
      if (path === "/api/v1/assets") return route.fulfill({ json: [] });
      if (path === "/api/v1/projects")
        return route.fulfill({
          json: {
            items: [
              {
                projectId: "aefea67c-caca-4300-923c-937f1c785578",
                title: "Silk Road",
                revision: 1,
                updatedAt: "2026-10-30T01:00:00Z",
                archived: false,
                permissions: {
                  canEdit: true,
                  canManage: role === "Educator",
                  canPublish: role === "Educator",
                },
              },
              {
                projectId: "bbf2b1d0-b388-4df8-a995-930148dcdd19",
                title: "Ancient Rome",
                revision: 1,
                updatedAt: "2026-10-30T01:00:00Z",
                archived: false,
                permissions: {
                  canEdit: true,
                  canManage: role === "Educator",
                  canPublish: role === "Educator",
                },
              },
            ],
            nextCursor: null,
          },
        });
      if (path === "/api/v1/classes")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ status: 404 });
    });
    await page.goto(origin + "/home");
    if (role === "Educator") {
      await page.getByRole("heading", { name: "All Projects", exact: true }).waitFor();
    } else {
      await page.getByRole("tab", { name: "Projects", exact: true }).waitFor();
    }
    assert.equal(
      await page.getByRole("heading", { name: welcome, exact: true }).count(),
      1,
      `${role} should see their welcome heading`,
    );
    const cards = page.locator(role === "Educator" ? ".sp-teacher-card" : ".sp-student-card");
    await cards.filter({ hasText: "Ancient Rome" }).waitFor();
    assert.equal(await cards.count(), 2);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    assert.ok(first && second);
    if (role === "Educator") {
      assert.ok(
        Math.abs(first.y - second.y) < 2 && second.x >= first.x + first.width,
        "Educator cards should be side-by-side at desktop width",
      );
      await cards.first().getByRole("button", { name: "View Details" }).click();
      await page.getByRole("heading", { name: "Project Details", exact: true }).waitFor();
      await page.getByRole("button", { name: "Close project details" }).click();
    } else {
      assert.ok(
        second.y >= first.y + first.height,
        "Creator cards should be stacked at desktop width",
      );
      await cards
        .first()
        .getByRole("button", { name: /view details/i })
        .click();
      await page
        .getByRole("region", { name: "Project details" })
        .getByRole("heading", { name: "Silk Road", exact: true })
        .waitFor();
      assert.equal(await page.getByRole("region", { name: "Project details" }).isVisible(), true);
      await page.getByRole("button", { name: "Close project details" }).click();
      assert.equal(
        await page.getByText("Manage projects and archives", { exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("button", { name: "New project", exact: true }).count(), 0);
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const title of ["Silk Road", "Ancient Rome"]) {
        const card = cards.filter({ hasText: title });
        assert.equal(
          await (
            role === "Educator" ? card.getByRole("button", { name: "View Details" }) : card
          ).isVisible(),
          true,
        );
      }
      const creation =
        role === "Educator"
          ? page.getByRole("link", { name: "New Project", exact: true })
          : page.getByRole("button", { name: "New project", exact: true });
      assert.equal(
        await creation.count(),
        role === "Educator" ? 1 : 0,
        `${role} creation permission at ${width}px`,
      );
      if (role === "Educator") assert.equal(await creation.isVisible(), true);
      if (role === "Educator") assert.equal(await creation.getAttribute("href"), "/new-project");
    }
    await page.close();
  }
  console.log("Home shows role-specific welcome headings");
} finally {
  await browser.close();
}
