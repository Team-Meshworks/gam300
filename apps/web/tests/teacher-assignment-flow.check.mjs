import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const teacher = "7ea0882b-9365-4b9c-b8b8-e5ee113ad07e";
const org = "ef580108-e406-4c8e-ac76-75cd41e9d2dc";
const classId = "a9f15e21-026d-4200-baca-0ba9bd411842";
const alice = "bbf2b1d0-b388-4df8-a995-930148dcdd19";
const bob = "cc0ec5ca-2991-403f-8527-d566028345ab";
const server = await createServer({
  cacheDir: "test-results/vite-teacher-assignment-flow",
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/session")
      return route.fulfill({
        json: {
          userId: teacher,
          displayName: "Ms Chew",
          orgId: org,
          orgName: "School",
          role: "Educator",
          mustChangePassword: false,
        },
      });
    if (path === "/api/v1/classes")
      return route.fulfill({
        json: { items: [{ id: classId, name: "History", organizationId: org }], nextCursor: null },
      });
    if (path === "/api/v1/projects")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/eligible-students"))
      return route.fulfill({
        json: {
          items: [
            { userId: alice, userName: "Alice", enrolled: true },
            { userId: bob, userName: "Bob", enrolled: false },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/roster"))
      return route.fulfill({
        json: {
          items: [
            {
              userId: alice,
              userName: "Alice",
              roleId: "862d776c-4d56-4dd8-919d-26044b6d8a44",
              accountActive: true,
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith("/assignments"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404 });
  });
  await page.goto(origin + "/classes");
  await page.getByLabel("Class", { exact: true }).selectOption(classId);
  await page.getByRole("button", { name: "New assignment", exact: true }).click();
  await page.getByRole("heading", { name: "Project details" }).waitFor();
  await page.getByRole("checkbox", { name: /Alice/ }).waitFor();
  const checks = [
    [
      "selected class retained",
      async () =>
        assert.equal(
          (await page.getByRole("combobox", { name: "Class *", exact: true }).innerText()).trim(),
          "History",
        ),
    ],
    [
      "enrolled student populated",
      async () => assert.equal(await page.getByRole("checkbox", { name: /Alice/ }).count(), 1),
    ],
    [
      "unenrolled student excluded",
      async () => assert.equal(await page.getByRole("checkbox", { name: /Bob/ }).count(), 0),
    ],
    [
      "source project selector absent",
      async () => assert.equal(await page.getByLabel("Source project").count(), 0),
    ],
    [
      "date input",
      async () => assert.equal(await page.locator("#project-due").getAttribute("type"), "date"),
    ],
    [
      "creator shown",
      async () =>
        assert.equal((await page.getByText("Ms Chew", { exact: true }).count()) > 0, true),
    ],
    [
      "organisation shown",
      async () => assert.equal((await page.getByText("School", { exact: true }).count()) > 0, true),
    ],
    [
      "edit later copy",
      async () =>
        assert.equal(
          await page
            .getByText("You can edit project details, students and the due date later.", {
              exact: true,
            })
            .count(),
          1,
        ),
    ],
  ];
  const failures = [];
  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, [], "Teacher assignment creation regression checks failed");
} finally {
  await browser?.close();
  await server.close();
}
