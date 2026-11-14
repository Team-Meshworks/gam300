import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

assert.ok(
  process.env.SPATIA_API_ORIGIN &&
    process.env.SPATIA_TEST_ADMIN &&
    process.env.SPATIA_TEST_CREATOR &&
    process.env.SPATIA_TEST_PROJECT,
);
const server = await createServer({
  cacheDir: "test-results/vite-project-grants-real",
  server: { port: 0, fs: { allow: [resolve("../.."), realpathSync("node_modules")] } },
  logLevel: "silent",
});
await server.listen();
const origin = `https://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await launchBrowser({ target: origin });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) console.error("HTTP error:", response.status(), response.url());
  });
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}/login`);
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(`${origin}/admin/dashboard`);
  await page.getByRole("link", { name: "View Organisations", exact: true }).click();
  await page.waitForURL(`${origin}/organisations`);
  await page.getByRole("link", { name: "Close organisations", exact: true }).click();
  await page.waitForURL(`${origin}/admin/dashboard`);
  await page.goto(`${origin}/home`);
  await page.getByRole("button", { name: "Classes", exact: true }).click();
  await page.getByRole("heading", { name: "Classes", exact: true }).waitFor();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Back to dashboard", exact: true }).click();
  await page.goto(`${origin}/home`);
  const project = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Grant browser project", exact: true }),
  });
  assert.equal(
    await project.getByRole("button", { name: "Manage access", exact: true }).count(),
    0,
  );
  assert.equal(
    await project.getByRole("button", { name: "Continue editing", exact: true }).count(),
    0,
  );
  assert.equal(await project.getByRole("button", { name: "Publish", exact: true }).count(), 0);
  const adminDenied = await page.evaluate(async (projectId) => {
    const path = `/api/v1/projects/${projectId}`;
    const draft = await (await fetch(path)).json();
    const csrf = await (await fetch("/api/v1/auth/csrf")).json();
    const send = async (url, method, body) =>
      (
        await fetch(url, {
          method,
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
          body: JSON.stringify(body),
        })
      ).status;
    return {
      permissions: draft.permissions,
      edit: await send(path, "PUT", {
        expectedRevision: draft.revision,
        clientMutationId: crypto.randomUUID(),
        document: draft.document,
      }),
      publish: await send(path + "/publications", "POST", {
        publicationId: crypto.randomUUID(),
        confirmedRevision: draft.revision,
        intent: { audience: "Public", viewerIds: [] },
      }),
      grants: await send(path + "/assignments", "PATCH", {
        expectedRevision: draft.revision,
        managedByUserIds: [],
        assignedCreatorIds: [],
        canPublishUserIds: [],
      }),
    };
  }, process.env.SPATIA_TEST_PROJECT);
  assert.deepEqual(adminDenied.permissions, {
    canEdit: false,
    canManage: false,
    canPublish: false,
  });
  assert.deepEqual([adminDenied.edit, adminDenied.publish, adminDenied.grants], [403, 403, 403]);
  const creatorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const creatorPage = await creatorContext.newPage();
  await creatorPage.goto(`${origin}/login`);
  await creatorPage.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_CREATOR);
  await creatorPage.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await creatorPage.getByRole("button", { name: "Log in", exact: true }).click();
  await creatorPage.waitForURL(`${origin}/home`);
  const denial = await creatorPage.evaluate(async (projectId) => {
    const path = `/api/v1/projects/${projectId}/assignments`;
    const read = await fetch(path);
    const csrf = await (await fetch("/api/v1/auth/csrf")).json();
    const write = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf.requestToken },
      body: JSON.stringify({
        expectedRevision: 1,
        managedByUserIds: [],
        assignedCreatorIds: [],
        canPublishUserIds: [],
      }),
    });
    return { read: read.status, write: write.status };
  }, process.env.SPATIA_TEST_PROJECT);
  assert.deepEqual(denial, { read: 403, write: 403 });
  await creatorContext.close();
  await context.close();
  console.log("Real API project access browser test passed");
} finally {
  await browser?.close();
  await server.close();
}
