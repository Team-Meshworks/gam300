import assert from "node:assert/strict";
import { createServer } from "vite";
import { createServer as createBridge } from "node:http";
import { request } from "node:https";
import { on } from "node:events";
import { existsSync, readFileSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./browser-security.mjs";

const sync = process.env.SPATIA_TEST_SYNC;
const assetId = process.env.SPATIA_TEST_ASSET;
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const upstream = `https://127.0.0.1:${server.httpServer.address().port}`;
let removals = 0;
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
    reconcileStarted(incoming.url);
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
            preference: response.headers["preference-applied"],
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
  const watcher = watch(sync);
  const changes = on(watcher, "change", { signal: AbortSignal.timeout(15_000) });
  try {
    while (!existsSync(join(sync, name))) await changes.next();
  } finally {
    await changes.return();
    watcher.close();
  }
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
  const path = await Promise.race([
    reconciling,
    card
      .getByRole("button")
      .waitFor()
      .then(() => {
        throw new Error("The stale removal action became reachable before reconciliation");
      }),
  ]);
  assert.equal(path, `/api/v1/admin/assets/${assetId}/removals/${operationId}/reconcile`);
  await page.getByRole("status", { name: "Loading assets" }).waitFor();
  assert.equal(await card.getByRole("button").count(), 0);
  assert.equal(removals, 1, "No fresh removal may be sent before the first outcome is resolved");
  await writeFile(join(sync, "release"), "release");
  const result = await completed;
  assert.equal(result.status, 201);
  assert.equal(result.preference, "spatia-created-status");
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
