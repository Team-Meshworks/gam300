import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url)),
);
const manifest = JSON.parse(
  readFileSync(new URL("../../../assets/manifest.json", import.meta.url)),
);
const room = manifest.assets.find((entry) => entry.assetId === "room-doors-2-v1");
const roomBytes = readFileSync(new URL(`../../../assets/${room.file}`, import.meta.url));
const assetId = "11111111-1111-4111-8111-111111111111";
const asset = {
  id: assetId,
  name: "Approved room",
  kind: "environment",
  url: `/api/v1/assets/${assetId}/bytes`,
  sha256: room.sha256,
  thumbnail: null,
  category: null,
};
let server;
if (!process.argv[2]) {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
  await server.listen();
}
const base = (process.argv[2] ?? `http://127.0.0.1:${server.httpServer.address().port}`).replace(
  /\/$/,
  "",
);
let browser;
try {
  browser = await launchBrowser({ target: base, args: ["--enable-unsafe-swiftshader"] });
  for (const method of ["click", "drag"]) {
    let revision = 0;
    let document = {
      ...fixture,
      title: `Empty ${method}`,
      scenes: [
        {
          ...fixture.scenes[0],
          environmentAssetId: null,
          objects: [],
          groups: [],
          zones: [],
          viewpoints: [],
          rules: [],
        },
      ],
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    const errors = [];
    const api = async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (status, body) => route.fulfill({ status, json: body });
      if (path === "/api/v1/auth/session")
        return json(200, {
          userId: "00000000-0000-4000-8000-000000000001",
          orgId: "00000000-0000-4000-8000-000000000002",
          displayName: "Student",
          role: "Creator",
          mustChangePassword: false,
          developmentAssetsAllowed: false,
        });
      if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
      if (path === "/api/v1/classes") return json(200, { items: [], nextCursor: null });
      if (path === "/api/v1/assets") return json(200, [asset]);
      if (path === "/api/v1/projects") {
        if (request.method() === "GET") return json(200, { items: [], nextCursor: null });
        assert.deepEqual(request.postDataJSON(), { title: `Empty ${method}` });
        return json(201, {
          projectId: fixture.projectId,
          revision: 0,
          updatedAt: "2026-11-05T00:00:00Z",
          archived: false,
        });
      }
      if (path === `/api/v1/projects/${fixture.projectId}/assets`)
        return json(
          200,
          document.scenes[0].environmentAssetId
            ? [{ ...asset, url: `/api/v1/projects/${fixture.projectId}/assets/${assetId}/bytes` }]
            : [],
        );
      if (
        path === asset.url ||
        path === `/api/v1/projects/${fixture.projectId}/assets/${assetId}/bytes`
      )
        return route.fulfill({ status: 200, contentType: "model/gltf-binary", body: roomBytes });
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
    let page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${base}/?projectId=${fixture.projectId}`;
    await page.goto(`${base}/home`);
    await page.getByText("Manage projects and archives", { exact: true }).click();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click()
      .catch(async (error) => {
        console.error(
          "Creation failed:",
          page.url(),
          await page.locator("body").innerText(),
          errors,
        );
        throw error;
      });
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog.getByLabel("Project title").fill(`Empty ${method}`);
    assert.match(
      await dialog.getByRole("combobox", { name: /3D space/ }).innerText(),
      /Empty scene/,
    );
    await dialog.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(url);
    await page.getByText("Scene ready", { exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Third person", exact: true }).click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    const choice = page.getByRole("button", { name: "Approved room", exact: true });
    if (method === "click") await choice.click();
    else {
      await page.evaluate(async (asset) => {
        const { editorModelCache } = await import("/graphics/scene.ts");
        const lease = await editorModelCache.acquire(asset, new AbortController().signal);
        const prototype = Object.getPrototypeOf(Object.getPrototypeOf(lease.value.model));
        const add = prototype.add;
        prototype.add = function (...nodes) {
          if (this.isScene)
            for (const node of nodes)
              if (node.name === "placement-preview") window.roomGhost = node;
          return add.apply(this, nodes);
        };
        lease.release();
      }, asset);
      const transfer = await page.evaluateHandle(() => new DataTransfer());
      await choice.dispatchEvent("dragstart", { dataTransfer: transfer });
      const stage = page.locator(".viewport-stage");
      await page.waitForFunction(
        (id) =>
          document.querySelector(".viewport-stage")?.getAttribute("data-dragging-asset") === id,
        assetId,
      );
      let validDrop = false;
      for (let i = 0; i < 150 && !validDrop; i++) {
        await stage.dispatchEvent("dragover", {
          clientX: 720,
          clientY: 500,
          dataTransfer: transfer,
        });
        validDrop = await page.evaluate(() => {
          let color;
          window.roomGhost?.traverse((node) => {
            if (node.isMesh) color = node.material.color.getHexString();
          });
          return window.roomGhost?.visible && color === "999999";
        });
        if (!validDrop) await page.waitForTimeout(100);
      }
      assert.ok(validDrop, "A first room has a valid drop preview");
      await stage.dispatchEvent("drop", { clientX: 720, clientY: 500, dataTransfer: transfer });
      await page
        .locator('.room-picker .asset-card-pick[aria-label="Approved room"]')
        .dispatchEvent("dragend", { dataTransfer: transfer });
    }
    const deadline = Date.now() + 10000;
    while (document.scenes[0].environmentAssetId !== assetId && Date.now() < deadline)
      await page.waitForTimeout(100);
    assert.equal(
      document.scenes[0].environmentAssetId,
      assetId,
      `${method} should set and save the first environment`,
    );
    await page.locator('.save-state[data-state="saved"]').waitFor();
    assert.deepEqual(document.scenes[0].objects, [], "First room does not add a companion object");
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
    await fresh.route("**/api/v1/**", api);
    page = await fresh.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page
      .getByText("Scene ready", { exact: true })
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.error("Reopen failed:", await page.locator("body").innerText(), errors);
        throw error;
      });
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    assert.match(
      await page.getByRole("combobox", { name: "Environment", exact: true }).innerText(),
      /Approved room/,
    );
    assert.deepEqual(errors, []);
    await fresh.close();
    await context.close();
  }
  console.log(
    "First approved environment saves and reopens for click and drag without a companion",
  );
} finally {
  await browser?.close();
  await server?.close();
}
