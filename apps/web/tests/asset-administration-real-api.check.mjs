import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";
import { createServer } from "vite";
import { createServer as createBridge } from "node:http";
import { request } from "node:https";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(process.env.SPATIA_API_ORIGIN && process.env.SPATIA_TEST_ADMIN);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const upstream = `https://127.0.0.1:${server.httpServer.address().port}`;
const bridge = createBridge((incoming, outgoing) => {
  const forwarded = request(
    upstream + incoming.url,
    {
      ca: readFileSync(process.env.SPATIA_DEV_TLS_CERT),
      method: incoming.method,
      headers: { ...incoming.headers, host: new URL(upstream).host },
    },
    (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    },
  );
  forwarded.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(forwarded);
});
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.address().port}`;
const browser = await launchBrowser({ target: origin });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const screenshots = process.env.CHECK_SCREENSHOT_DIR ?? "test-results/admin-assets-real-api";
  mkdirSync(screenshots, { recursive: true });
  await page.goto(origin + "/login");
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  await page.goto(origin + "/assets");
  await page.getByText("No assets yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Add Assets", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const policy = await page.evaluate(async () => (await fetch("/api/v1/admin/assets")).json());
  assert.equal(policy.policy.canSubmitByKind.model, true);
  assert.ok(policy.policy.categories.model.includes("Objects"));
  const file = fileURLToPath(
    new URL("../../../assets/source/stands-displays/display-cube-v1.glb", import.meta.url),
  );
  await dialog.locator('input[type="file"]').setInputFiles(file);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/admin/assets",
  );
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  const saved = await response;
  assert.equal(saved.status(), 201);
  await dialog.waitFor({ state: "hidden" });
  const uploaded = await page.evaluate(
    async () => (await (await fetch("/api/v1/admin/assets")).json()).assets,
  );
  assert.equal(uploaded.length, 1);
  const record = uploaded[0];
  assert.equal(record.name, "display-cube-v1");
  assert.equal(record.status, "approved");
  assert.equal(record.category, "Objects");
  await page.reload();
  let card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: record.name, exact: true }) });
  await card.waitFor();
  await page.screenshot({ path: resolve(screenshots, "01-upload-persisted.png") });
  await card.getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  // The dialog closes before React clears its deep link. Reload the confirmed library URL.
  await page.waitForURL(origin + "/assets");
  await page.reload();
  let stored = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/v1/admin/assets")).json()).assets.find((x) => x.id === id),
    record.id,
  );
  assert.equal(stored.hidden, true);
  card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: record.name, exact: true }) });
  await card.getByRole("button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForURL(origin + "/assets");
  await page.reload();
  stored = await page.evaluate(
    async (id) =>
      (await (await fetch("/api/v1/admin/assets")).json()).assets.find((x) => x.id === id),
    record.id,
  );
  assert.equal(stored.hidden, false);
  assert.equal(stored.deleted, false);
  assert.equal(stored.id, record.id);
  await page.screenshot({ path: resolve(screenshots, "02-visibility-restored.png") });
  console.log(
    "Real API asset browser workflow passed: empty library, repository GLB upload, reload durability, hide and restore",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => bridge.close(resolve));
  await server.close();
}
