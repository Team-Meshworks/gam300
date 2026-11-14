import assert from "node:assert/strict";
import { createServer } from "vite";
import { createServer as createBridge } from "node:http";
import { request } from "node:https";
import { readFileSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./browser-security.mjs";

const sync = process.env.SPATIA_TEST_SYNC;
const assetId = process.env.SPATIA_TEST_ASSET;
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const upstream = `https://127.0.0.1:${server.httpServer.address().port}`;
let removals = 0;
let reconciliations = 0;
let operationId;
let committed;
let disconnected;
let reconcileStarted;
const reconciling = new Promise((resolve) => (reconcileStarted = resolve));
const completed = new Promise((resolve) => (committed = resolve));
const browserDisconnected = new Promise((resolve) => (disconnected = resolve));
const bridge = createBridge((incoming, outgoing) => {
  const isRemoval =
    (incoming.method === "POST" &&
      incoming.url === `/api/v1/admin/assets/${assetId}/availability`) ||
    (incoming.method === "PUT" &&
      incoming.url.startsWith(`/api/v1/admin/assets/${assetId}/removals/`));
  if (incoming.method === "POST" && incoming.url.endsWith("/reconcile")) {
    reconciliations++;
    reconcileStarted();
  }
  const removalNumber = isRemoval ? ++removals : 0;
  if (removalNumber === 1 && incoming.method === "PUT")
    operationId = incoming.url.split("/").at(-1);
  const forwarded = request(
    upstream + incoming.url,
    {
      ca: readFileSync(process.env.SPATIA_DEV_TLS_CERT),
      method: incoming.method,
      headers: { ...incoming.headers, host: new URL(upstream).host },
    },
    (response) => {
      if (removalNumber === 1) {
        response.resume();
        response.on("end", () =>
          committed({
            status: response.statusCode,
            operation: response.headers["x-spatia-operation-id"],
          }),
        );
      } else {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      }
    },
  );
  forwarded.on("error", () => {
    if (!outgoing.destroyed) {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    }
  });
  if (removalNumber === 1) {
    outgoing.on("close", () => disconnected());
    incoming.on("end", async () => {
      if (operationId) await writeFile(join(sync, "operation"), operationId);
      await writeFile(join(sync, "forwarded"), "sent");
    });
  }
  incoming.pipe(forwarded);
});
await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${bridge.address().port}`;
const browser = await launchBrowser({ target: origin });
async function waitForFile(name) {
  for (let i = 0; i < 300; i++) {
    if (
      await access(join(sync, name)).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${name}`);
}
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin + "/login");
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(origin + "/admin/dashboard");
  await page.goto(origin + "/spaces");
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  const card = page
    .locator(".asset-admin-card")
    .filter({ has: page.getByRole("heading", { name: "Receipt race room", exact: true }) });
  await card.getByRole("button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete Permanently", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete Permanently", exact: true }).click();
  await waitForFile("blocked");
  await page.goto(origin + "/admin/dashboard");
  await Promise.race([
    browserDisconnected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Browser did not abort removal")), 5000),
    ),
  ]);
  const old = await page.evaluate(async (id) => {
    const response = await fetch("/api/v1/admin/assets", { credentials: "same-origin" });
    return {
      status: response.status,
      asset: (await response.json()).assets.find((item) => item.id === id),
    };
  }, assetId);
  assert.equal(old.status, 200);
  assert.equal(
    old.asset.removedFromProjects,
    false,
    "Catalogue GET really completed before commit",
  );
  await page.goto(origin + "/spaces");
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  await Promise.race([reconciling, card.getByRole("button").waitFor()]);
  if (
    await card
      .getByRole("button")
      .isVisible()
      .catch(() => false)
  ) {
    await card.getByRole("button").click();
    const remove = dialog.getByRole("button", { name: "Delete Permanently", exact: true });
    if (await remove.isVisible().catch(() => false)) {
      await remove.click();
      await remove.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.equal(removals, 1, "No fresh removal may be sent before the first outcome is resolved");
  assert.ok(reconciliations > 0, "The original removal is reconciled before another write");
  await writeFile(join(sync, "release"), "release");
  const result = await completed;
  assert.equal(result.status, 200);
  assert.equal(result.operation, operationId);
  await page.reload();
  await page.getByRole("button", { name: /^Deleted \(/ }).click();
  await card.getByRole("button").click();
  await dialog
    .getByText("Removed from projects. Affected published exhibitions are permanently unavailable.")
    .waitFor();
  assert.equal(removals, 1);
  console.log("Real asset removal browser race passed");
} finally {
  await writeFile(join(sync, "release"), "release");
  await browser.close();
  await new Promise((resolve) => bridge.close(resolve));
  await server.close();
}
