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
let revision = 1;
let catalogueUnavailable = false;
let assetRows = [];
let failSave = false;
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
const manifest = JSON.parse(
  readFileSync(new URL("../../../assets/manifest.json", import.meta.url), "utf8"),
);
const roomSources = manifest.assets.filter((asset) => asset.kind === "environment").slice(0, 4);
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
        role: "Creator",
        mustChangePassword: false,
        developmentAssetsAllowed: false,
      });
    if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
    if (path === "/api/v1/assets") return json(catalogueUnavailable ? 503 : 200, assetRows);
    if (path === `/api/v1/projects/${fixture.projectId}/assets`)
      return json(
        200,
        assetRows.map((asset) => ({ ...asset, url: `${path}/${asset.id}/bytes` })),
      );
    if (path.endsWith("/bytes"))
      return route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        body: readFileSync(
          new URL(
            "../../../assets/" +
              manifest.assets.find(
                (asset) => asset.sha256 === assetRows.find((row) => path.includes(row.id))?.sha256,
              ).file,
            import.meta.url,
          ),
        ),
      });
    if (path === `/api/v1/projects/${fixture.projectId}`) {
      if (request.method() === "GET")
        return json(200, {
          projectId: fixture.projectId,
          revision,
          document,
          permissions: { canEdit: true },
        });
      if (failSave) return json(503, {});
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
  // First-open setup is separate from editing an already saved blank project.
  catalogueUnavailable = false;
  revision = 0;
  document = { ...document, scenes: [{ ...document.scenes[0], name: "Scene 1" }] };
  assetRows = Array.from({ length: 4 }, (_, index) => {
    const id = `10000000-0000-4000-8000-00000000000${index + 1}`;
    return {
      id,
      name: `Gallery ${index + 1}`,
      kind: "environment",
      category: null,
      url: `/api/v1/assets/${id}/bytes`,
      thumbnail: null,
      sha256: roomSources[index].sha256,
    };
  });
  const setup = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  await setup.route("**/api/v1/**", api);
  const chooser = await setup.newPage();
  await chooser.goto(url);
  await chooser.getByRole("heading", { name: "Choose your base model...", exact: true }).waitFor();
  const continueEditing = chooser.getByRole("button", { name: "Continue Editing", exact: true });
  assert.equal(await continueEditing.isDisabled(), true);
  assert.equal(
    await chooser.getByRole("group", { name: "Base models" }).getByRole("button").count(),
    4,
  );
  await chooser.locator(".viewport-stage canvas").waitFor();
  const beforeCancel = writes.length;
  const bounds = await chooser
    .locator(".sp-base-model-grid")
    .evaluate((e) => ({ height: e.clientHeight, content: e.scrollHeight }));
  assert.equal(bounds.height, bounds.content, "Four models fit without scrolling");
  const padding = await chooser.locator(".sp-base-model-grid").evaluate((e) => {
    const style = getComputedStyle(e);
    return [style.paddingTop, style.paddingBottom];
  });
  assert.equal(padding[0], padding[1], "Model list top and bottom padding match");

  await chooser.getByRole("button", { name: "Close base model chooser", exact: true }).click();
  await chooser.locator(".sp-base-model-dialog").waitFor({ state: "hidden" });
  assert.equal(chooser.url(), url, "Cancelling keeps the editor open");
  assert.equal(writes.length, beforeCancel);
  await chooser.goto(url);
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser.locator(".sp-base-model-dialog").waitFor({ state: "hidden" });
  assert.equal(chooser.url(), url, "Cancelling keeps the editor open");
  assert.equal(writes.length, beforeCancel, "Cancelling either way must not save a model");
  // Additional models scroll inside the padded list; the decision controls stay stationary.
  assetRows.push(
    ...manifest.assets
      .filter((asset) => asset.kind === "environment")
      .slice(4, 6)
      .map((source, index) => {
        const id = `10000000-0000-4000-8000-00000000000${index + 5}`;
        return {
          ...assetRows[0],
          id,
          name: `Gallery ${index + 5}`,
          url: `/api/v1/assets/${id}/bytes`,
          sha256: source.sha256,
        };
      }),
  );
  await chooser.goto(url);
  const grid = chooser.locator(".sp-base-model-grid");
  await chooser
    .getByRole("button", { name: "Gallery 6", exact: true })
    .waitFor({ state: "attached" });
  const header = chooser.locator(".sp-base-model-panel header");
  const footer = chooser.locator(".sp-base-model-panel footer");
  const beforeScroll = [await header.boundingBox(), await footer.boundingBox()];
  assert.equal(await grid.evaluate((e) => e.scrollHeight > e.clientHeight), true);
  await grid.evaluate((e) => (e.scrollTop = e.scrollHeight));
  assert.deepEqual([await header.boundingBox(), await footer.boundingBox()], beforeScroll);
  const popupBounds = await chooser.locator(".sp-base-model-dialog").boundingBox();
  const listBounds = await grid.boundingBox();
  assert.ok(
    popupBounds.x + popupBounds.width - listBounds.x - listBounds.width >= 24,
    "Scrollbar stays inset from the popup edge",
  );
  await chooser.getByRole("button", { name: "Cancel", exact: true }).click();
  await chooser.locator(".sp-base-model-dialog").waitFor({ state: "hidden" });
  assert.equal(chooser.url(), url, "Cancelling keeps the editor open");
  assetRows = assetRows.slice(0, 4);
  await setup.close();
  const selecting = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  await selecting.route("**/api/v1/**", api);
  const firstEdit = await selecting.newPage();
  await firstEdit.goto(url);
  await firstEdit.getByRole("button", { name: "Gallery 2", exact: true }).click();
  await firstEdit.evaluate(() => document.fonts.ready);
  await firstEdit.waitForFunction(
    () => document.querySelectorAll(".sp-base-model-grid img").length === 4,
  );

  const frames = await firstEdit.locator(".sp-base-model-grid img").evaluateAll(async (images) => {
    return Promise.all(
      images.map(async (image) => {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 320;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, 320, 320);
        const pixels = context.getImageData(0, 0, 320, 320).data;
        let left = 320,
          top = 320,
          right = -1,
          bottom = -1;
        for (let y = 0; y < 320; y++)
          for (let x = 0; x < 320; x++)
            if (pixels[(y * 320 + x) * 4 + 3] > 16) {
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
        return {
          centerX: (left + right) / 2,
          centerY: (top + bottom) / 2,
          size: Math.max(right - left + 1, bottom - top + 1),
        };
      }),
    );
  });
  for (const frame of frames) {
    assert.ok(
      Math.abs(frame.centerX - 159.5) <= 2 && Math.abs(frame.centerY - 159.5) <= 2,
      "Each visible room is centred",
    );
    assert.ok(
      frame.size >= 284 && frame.size <= 292,
      "Each visible room uses the same preview frame",
    );
  }
  const typography = await firstEdit.locator(".sp-base-model-panel").evaluate((panel) => ({
    heading: parseFloat(getComputedStyle(panel.querySelector("h1")).fontSize),
    description: parseFloat(getComputedStyle(panel.querySelector("header p")).fontSize),
    action: parseFloat(getComputedStyle(panel.querySelector("footer button")).fontSize),
  }));
  assert.ok(
    typography.heading > typography.action && typography.action > typography.description,
    "Figma heading, action and description hierarchy stays distinct",
  );
  const previewCard = firstEdit.getByRole("button", { name: "Gallery 1", exact: true });
  await previewCard.hover();
  assert.equal(await previewCard.evaluate((e) => getComputedStyle(e).filter), "brightness(0.94)");
  await firstEdit.mouse.move(0, 0);
  await firstEdit.screenshot({ path: "test-results/creator-base-model-desktop.png" });
  await firstEdit.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await firstEdit.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await firstEdit.screenshot({ path: "test-results/creator-base-model-mobile.png" });
  await firstEdit.setViewportSize({ width: 1440, height: 1024 });
  failSave = true;
  await firstEdit.getByRole("button", { name: "Continue Editing", exact: true }).click();
  await firstEdit.getByRole("alert").filter({ hasText: "could not be saved" }).waitFor();
  assert.equal(
    await firstEdit
      .getByRole("dialog", { name: "Choose your base model...", exact: true })
      .isVisible(),
    true,
  );
  failSave = false;
  await firstEdit.getByRole("button", { name: "Continue Editing", exact: true }).click();
  await firstEdit
    .getByRole("dialog", { name: "Choose your base model...", exact: true })
    .waitFor({ state: "hidden" });
  await firstEdit.getByText("Scene ready", { exact: true }).waitFor();
  assert.equal(document.scenes[0].environmentAssetId, assetRows[1].id);
  assert.equal(revision, 1);
  await selecting.close();
  const returning = await browser.newContext();
  await returning.route("**/api/v1/**", api);
  const continued = await returning.newPage();
  await continued.goto(url);
  await continued.getByText("Scene ready", { exact: true }).waitFor();
  assert.equal(
    await continued
      .getByRole("heading", { name: "Choose your base model...", exact: true })
      .count(),
    0,
  );
  await returning.close();
  console.log(
    "Blank editing and first-open base selection pass, including modal setup, failed-save retry and reopening",
  );
} finally {
  await browser.close();
}
