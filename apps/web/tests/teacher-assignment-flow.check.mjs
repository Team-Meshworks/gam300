import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
import { creationRecoveryFixture } from "./creation-recovery-fixture.mjs";

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
  const receipts = creationRecoveryFixture();
  const projectWrites = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await receipts.handle(route, teacher)) return;
    if (path === "/api/v1/auth/csrf")
      return route.fulfill({ json: { requestToken: "test-token" } });
    if (path === "/api/v1/projects" && route.request().method() === "POST") {
      projectWrites.push(route.request().postDataJSON());
      return route.fulfill({ status: 422, json: { code: "fixture_rejected" } });
    }
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
  await page.getByRole("combobox", { name: "Class", exact: true }).click();
  await page.getByRole("option", { name: "History", exact: true }).click();
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
      "unenrolled student excluded",
      async () => assert.equal(await page.getByRole("checkbox", { name: /Bob/ }).count(), 0),
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

  await page.goto(origin + "/home");
  await page.getByRole("link", { name: "+ New Project", exact: true }).click();
  await page.getByRole("heading", { name: "New Project", exact: true }).waitFor();
  const coverType = page.getByRole("radio", { name: "Cover image" });
  const panoramaType = page.getByRole("radio", { name: "360°" });
  const gallery = page.getByRole("button", { name: "Gallery" });
  const selectedWeight = (radio) =>
    radio.evaluate((node) => Number(getComputedStyle(node.closest("label")).fontWeight));
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), gallery.click()]);
  await chooser.setFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await page.getByRole("img", { name: "Selected cover image" }).waitFor();
  await page.screenshot({ path: "test-results/facilitator-image-selection.png" });
  assert.equal(await coverType.isChecked(), true);
  assert.ok(
    (await selectedWeight(coverType)) > (await selectedWeight(panoramaType)),
    "The checked cover image type remains visibly selected after choosing a file",
  );
  assert.equal(
    await gallery.getAttribute("aria-pressed"),
    null,
    "Gallery opens a file chooser, not a toggle",
  );
  await coverType.click();
  assert.ok((await selectedWeight(coverType)) > (await selectedWeight(panoramaType)));
  await page.getByLabel("Project title").fill("Image test");
  await page.getByLabel("Project description").fill("Description");
  await page.getByLabel("Project instructions").fill("Instructions");
  await page.getByLabel(/^Due date/).fill("2035-12-01");
  await page.getByRole("combobox", { name: /^Class/ }).click();
  await page.getByRole("option", { name: "History", exact: true }).click();
  await page.getByRole("checkbox", { name: /Alice/ }).check();
  await panoramaType.check();
  assert.ok((await selectedWeight(panoramaType)) > (await selectedWeight(coverType)));
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "twice as wide as it is high" }).waitFor();
  assert.equal(
    projectWrites.length,
    0,
    "A square image is rejected for 360° before any project write",
  );
  await coverType.check();
  assert.equal(await coverType.isChecked(), true);
  assert.ok((await selectedWeight(coverType)) > (await selectedWeight(panoramaType)));
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/projects" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await created;
  assert.equal(projectWrites.length, 1);
  assert.equal(projectWrites[0].image.type, "cover");
  assert.equal(projectWrites[0].image.contentType, "image/png");
  assert.ok(
    projectWrites[0].image.data.length > 0,
    "The original selected image is encoded for the project",
  );
  console.log("PASS image choice remains clear after uploading and switching types");
} finally {
  await browser?.close();
  await server.close();
}
