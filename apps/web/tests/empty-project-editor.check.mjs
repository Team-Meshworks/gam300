import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchBrowser } from "./browser-security.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:5182";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
const userId = "00000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000002";
const browser = await launchBrowser({ target: base });
const context = await browser.newContext();
let revision = 0;
let catalogueUnavailable = false;
let document = {
  ...fixture,
  title: "Blank project",
  scenes: [
    {
      ...fixture.scenes[0],
      name: "Scene 1",
      environmentAssetId: null,
      objects: [],
      groups: [],
      zones: [],
      viewpoints: [],
      rules: [],
    },
  ],
};
const writes = [];
try {
  const api = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) => route.fulfill({ status, json: body });
    if (path === "/api/v1/auth/session")
      return json(200, {
        userId,
        orgId,
        displayName: "Teacher",
        role: "Educator",
        mustChangePassword: false,
        developmentAssetsAllowed: false,
      });
    if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
    if (path === "/api/v1/assets") return json(catalogueUnavailable ? 503 : 200, []);
    if (path === `/api/v1/projects/${fixture.projectId}/assets`) return json(200, []);
    if (path === `/api/v1/projects/${fixture.projectId}`) {
      if (request.method() === "GET")
        return json(200, {
          projectId: fixture.projectId,
          revision,
          document,
          permissions: { canEdit: true },
        });
      const body = request.postDataJSON();
      assert.equal(body.expectedRevision, revision);
      assert.equal(request.headers()["x-csrf-token"], "test-token");
      writes.push(body);
      document = body.document;
      return json(200, {
        projectId: fixture.projectId,
        clientMutationId: body.clientMutationId,
        revision: ++revision,
      });
    }
    return json(404, {});
  };
  await context.route("**/api/v1/**", api);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `${base}/?projectId=${fixture.projectId}`;
  await page.goto(url);
  await page.getByText("Scene ready", { exact: true }).waitFor();
  const canvas = page.locator(".viewport-stage canvas");
  await canvas.waitFor();
  assert.ok(await canvas.evaluate((element) => element.width > 0 && element.height > 0));
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name", { exact: true }).fill("Empty scene edited");
  await page.getByRole("button", { name: "Rename scene", exact: true }).click();
  await page.locator('.save-state[data-state="saved"]').waitFor();
  assert.equal(writes.length, 1);
  assert.equal(document.scenes[0].name, "Empty scene edited");
  assert.equal(document.scenes[0].environmentAssetId, null);
  assert.deepEqual(document.scenes[0].objects, []);
  const fresh = await browser.newContext();
  await fresh.route("**/api/v1/**", api);
  const reopened = await fresh.newPage();
  reopened.setDefaultTimeout(15000);
  await reopened.goto(url);
  await reopened.getByText("Scene ready", { exact: true }).waitFor();
  await reopened.getByRole("button", { name: "Scenes", exact: true }).click();
  assert.equal(
    await reopened.getByLabel("Scene name", { exact: true }).inputValue(),
    "Empty scene edited",
  );
  assert.deepEqual(errors, []);
  await fresh.close();
  catalogueUnavailable = true;
  const outage = await browser.newContext();
  await outage.route("**/api/v1/**", api);
  const unavailable = await outage.newPage();
  unavailable.setDefaultTimeout(8000);
  await unavailable.goto(url);
  await unavailable.getByText("Scene ready", { exact: true }).waitFor();
  await unavailable
    .getByText(/(?:assets|catalogue).*(?:unavailable|could not|couldn.t)/i)
    .waitFor();
  assert.equal(await unavailable.locator(".viewport-stage canvas").count(), 1);
  await outage.close();
  console.log("Empty server project renders the real editor and saves and reopens its scene");
} finally {
  await browser.close();
}
