import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { launchBrowser } from "../../web/tests/browser-security.mjs";

const api = new URL(process.argv[2]);
assert.equal(api.protocol, "https:");
assert.equal(api.hostname, "127.0.0.1");
const data = JSON.parse(process.argv[3]);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const origin = `https://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: path.resolve("../web"),
    env: {
      ...process.env,
      SPATIA_API_ORIGIN: api.origin,
      SPATIA_DEV_TLS_CERT: data.certificate,
      SPATIA_DEV_TLS_KEY: data.key,
      SPATIA_API_CA: data.certificate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let viteOutput = "";
vite.stdout.on("data", (chunk) => {
  viteOutput += chunk;
});
vite.stderr.on("data", (chunk) => {
  viteOutput += chunk;
});
const ca = readFileSync(data.certificate);
async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite stopped: ${viteOutput}`);
    const ok = await new Promise((resolve) => {
      const request = https.get(origin + "/login", { ca }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteOutput}`);
}
let browser;
try {
  await ready();
  browser = await launchBrowser({
    target: origin,
    args: ["--enable-unsafe-swiftshader"],
    verificationOutput: "stdout",
  });
  console.log(`Node ${process.version}; Chromium ${browser.version()}`);
  const pages = {};
  for (const name of ["student", "educator", "viewer", "unrelated"]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (name === "student")
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    // Observe the real visitor scene through Three's devtools hook, without application test hooks.
    await context.addInitScript(() => {
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__publicationScenes = [];
      window.__publicationCamera = undefined;
      window.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
        if (event.detail.isScene) window.__publicationScenes.push(event.detail);
        if (event.detail.isWebGLRenderer) {
          const renderer = event.detail;
          const render = renderer.render;
          renderer.render = (scene, camera) => {
            window.__publicationCamera = camera;
            return render.call(renderer, scene, camera);
          };
        }
      });
    });
    pages[name] = await context.newPage();
    pages[name].setDefaultTimeout(15000);
  }
  async function login(page, name) {
    await page.getByLabel("Username", { exact: true }).fill(data[name]);
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
  }
  const student = pages.student;
  await student.goto(`${origin}/login`);
  await login(student, "student");
  await student.waitForURL(`${origin}/home`);
  await student.goto(`${origin}/publish?projectId=${data.projectId}`);
  await student.getByRole("heading", { name: "Publish project" }).waitFor();
  await student.getByRole("combobox", { name: "Who can open this publication" }).click();
  await student.getByRole("option", { name: "Anyone with the link", exact: true }).click();
  await student.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  const posted = student.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/v1/projects/${data.projectId}/publications`,
  );
  await student.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await posted;
  assert.equal(response.status(), 201, `Publish failed: ${await response.text()}`);
  const request = response.request().postDataJSON();
  assert.deepEqual(request.intent, { audience: "Unlisted", viewerIds: [] });
  const link = student.getByRole("link", { name: "Open publication" });
  await link.waitFor();
  const linkValue = await link.getAttribute("href");
  assert.equal(linkValue, `https://publications.example.test/p/${request.publicationId}`);
  const qr = student.getByRole("img", { name: /QR code/i });
  const pixels = await qr.evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 416;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 416, 416);
    context.drawImage(image, 0, 0, 416, 416);
    return Array.from(context.getImageData(0, 0, 416, 416).data);
  });
  const decode = createRequire(new URL("../../web/package.json", import.meta.url))("jsqr");
  const decoded = decode(new Uint8ClampedArray(pixels), 416, 416)?.data;
  assert.equal(decoded, linkValue);
  for (const [page, url] of [
    [pages.viewer, linkValue],
    [pages.unrelated, decoded],
  ]) {
    const path = new URL(url).pathname;
    const assetResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/publications/${request.publicationId}/assets/`) &&
        r.url().endsWith("/assets/test-room-v1/bytes"),
    );
    await page.goto(`${origin}${path}`);
    await page.getByRole("status").getByText("Exhibition ready").waitFor({ timeout: 30000 });
    assert.equal(await page.locator("canvas[aria-label='Exhibition view']").count(), 1);
    const placement = await page.evaluate(async (publicationId) => {
      const manifest = await fetch(`/api/v1/publications/${publicationId}/manifest`).then((r) =>
        r.json(),
      );
      const cube = manifest.assets.find((asset) => asset.id === "display-cube-v1");
      const root = window.__publicationScenes
        .map((scene) => scene.getObjectByName("dddddddd-dddd-4ddd-8ddd-dddddddddddd"))
        .find(Boolean);
      if (!root) throw new Error("The published display cube was not rendered.");
      root.updateWorldMatrix(true, true);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      root.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry.computeBoundingBox();
        const bounds = node.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
        for (const [index, axis] of ["x", "y", "z"].entries()) {
          min[index] = Math.min(min[index], bounds.min[axis]);
          max[index] = Math.max(max[index], bounds.max[axis]);
        }
      });
      return {
        placement: cube.placement,
        position: root.position.toArray(),
        bottomCenter: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2],
        height: max[1] - min[1],
      };
    }, request.publicationId);
    assert.equal(placement.placement, "bottom-center");
    assert.deepEqual(placement.position, [2, 0, -3]);
    for (const [index, expected] of [2, 0, -3].entries())
      assert.ok(
        Math.abs(placement.bottomCenter[index] - expected) < 0.0001,
        `Published display cube has an exporter offset: ${JSON.stringify(placement)}`,
      );
    assert.ok(Math.abs(placement.height - 1.2) < 0.001);

    const crate = await page.evaluate(async (publicationId) => {
      const manifest = await fetch(`/api/v1/publications/${publicationId}/manifest`).then((r) =>
        r.json(),
      );
      const root = window.__publicationScenes
        .map((scene) => scene.getObjectByName("99999999-9999-4999-8999-999999999999"))
        .find(Boolean);
      if (!root) throw new Error("The published trigger crate was not rendered.");
      return {
        nonBlocking: manifest.assets.find((item) => item.id === "trigger-crate-v1")?.nonBlocking,
        z: root.position.z,
      };
    }, request.publicationId);
    assert.equal(crate.nonBlocking, true);
    const before = await page.evaluate(() => window.__publicationCamera?.position.toArray());
    assert.ok(Array.isArray(before) && before[2] > crate.z + 1, `Visitor did not start behind the crate: ${JSON.stringify(before)}`);
    await page.locator("canvas[aria-label='Exhibition view']").focus();
    await page.keyboard.down("w");
    let after;
    try {
      const deadline = Date.now() + 5000;
      do {
        await page.waitForTimeout(100);
        after = await page.evaluate(() => window.__publicationCamera?.position.toArray());
      } while (Array.isArray(after) && after[2] > crate.z - 0.8 && Date.now() < deadline);
    } finally {
      await page.keyboard.up("w");
    }
    assert.ok(
      Array.isArray(after) && after[2] < crate.z - 0.8,
      `Visitor did not walk through the published crate: ${JSON.stringify({ before, after, crate })}`,
    );

    const asset = await assetResponse;
    assert.equal(asset.status(), 200);
    assert.equal(
      createHash("sha256")
        .update(await asset.body())
        .digest("hex"),
      "121c9d86eefb1961a697a390967dfeface3ce1f612334d2fbc447551ddfd88d1",
    );
  }
  console.log("starter publication browser passed");
} finally {
  await browser?.close();
  vite.kill();
  await new Promise((resolve) => {
    if (vite.exitCode !== null) resolve();
    else vite.once("exit", resolve);
  });
}
