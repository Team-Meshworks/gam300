import assert from "node:assert/strict";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

for (const name of [
  "SPATIA_API_ORIGIN",
  "SPATIA_TEST_EDUCATOR",
  "SPATIA_TEST_STUDENT",
  "SPATIA_TEST_CLASS",
])
  assert.ok(process.env[name], "Missing " + name);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const origin = "https://127.0.0.1:" + server.httpServer.address().port;
let browser;
async function login(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(origin + "/login");
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_EDUCATOR);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(origin + "/home");
  return page;
}
async function head(context, actor) {
  const response = await context.request.get(
    origin + "/api/v1/creation-operations/assignment-source",
    { headers: { "X-Spatia-Account": actor } },
  );
  assert.equal(response.status(), 200);
  assert.match(response.headers()["cache-control"], /no-store/);
  return response.json();
}
let creations = 0,
  assignments = 0;
try {
  browser = await launchBrowser({ target: origin });
  const first = await browser.newContext({ ignoreHTTPSErrors: true, timezoneId: "Asia/Singapore" });
  const page = await login(first);
  const session = await (await first.request.get(origin + "/api/v1/auth/session")).json();
  const actor = session.userId;
  assert.deepEqual(await head(first, actor), { operationId: null, state: "ready", receipt: null });
  let commit, rejectCommit;
  const committed = new Promise((resolve, reject) => {
    commit = resolve;
    rejectCommit = reject;
  });
  void committed.catch(() => {});
  await first.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creations++;
    try {
      const body = route.request().postDataJSON();
      assert.equal(route.request().headers()["x-spatia-account"], actor);
      assert.deepEqual(body.creationGuard, {
        purpose: "assignment-source",
        previousOperationId: null,
      });
      assert.match(body.operationId, /^[0-9a-f-]{36}$/);
      assert.equal(body.image.type, "cover");
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const receipt = await response.json();
      commit({ body, receipt });
    } catch (cause) {
      rejectCommit(cause);
    }
    await route.abort("failed");
  });
  await first.route("**/api/v1/classes/*/assignments", async (route) => {
    if (route.request().method() === "POST") assignments++;
    await route.continue();
  });
  await page.goto(origin + "/new-project");
  await page.getByLabel("Project title").fill("Cross-profile recovered source");
  await page.getByLabel("Project description").fill("Keep the single original source.");
  await page
    .getByLabel("Project instructions")
    .fill("Do not assign until this source is reviewed.");
  await page.getByLabel(/^Due date/).fill("2035-12-01");
  const classControl = page.getByRole("combobox", { name: /^Class/ });
  const classRows = await (await first.request.get(origin + "/api/v1/classes?limit=20")).json();
  const selected = classRows.items.find((item) => item.id === process.env.SPATIA_TEST_CLASS);
  assert.ok(selected);
  if (await classControl.evaluate((element) => element.tagName === "SELECT"))
    await classControl.selectOption(selected.id);
  else {
    await classControl.click();
    await page.getByRole("option", { name: selected.name, exact: true }).click();
  }
  await page.getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) }).check();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    const context = canvas.getContext("2d");
    context.fillStyle = "#369";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("Choose cover image", { exact: true }).setInputFiles({
    name: "original-only.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await page.getByAltText("Selected cover image").waitFor();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  const lost = await committed;
  await page.getByRole("alert").filter({ hasText: "Creation is unconfirmed" }).first().waitFor();
  const outstanding = await head(first, actor);
  assert.equal(outstanding.state, "unacknowledged");
  assert.equal(outstanding.operationId, lost.body.operationId);
  assert.deepEqual(outstanding.receipt, lost.receipt);
  assert.equal(assignments, 0);
  await first.close();

  const second = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const recoveredPage = await login(second);
  assert.equal(
    await recoveredPage.evaluate(
      (key) => localStorage.getItem(key),
      "spatia.assignment.source:" + actor,
    ),
    null,
  );
  await second.route("**/api/v1/projects", async (route) => {
    if (route.request().method() === "POST") creations++;
    await route.continue();
  });
  await second.route("**/api/v1/classes/*/assignments", async (route) => {
    if (route.request().method() === "POST") assignments++;
    await route.continue();
  });
  let loseAck = true;
  await second.route(
    "**/api/v1/creation-operations/assignment-source/*/acknowledge",
    async (route) => {
      const durable = await recoveredPage.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)),
        "spatia.assignment.source:" + actor,
      );
      assert.equal(durable.adopted, true);
      assert.equal(durable.actorId, actor);
      assert.equal(durable.receipt.projectId, lost.receipt.projectId);
      assert.equal(durable.operationId, lost.body.operationId);
      const response = await route.fetch();
      assert.equal(response.status(), 204);
      if (loseAck) {
        loseAck = false;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    },
  );
  await recoveredPage.goto(origin + "/new-project");
  const recovery = recoveredPage.getByRole("region", {
    name: "Release pending assignment-source request",
  });
  await recovery.getByRole("button", { name: "Review recovered project", exact: true }).click();
  await recovery.getByText(new RegExp(lost.receipt.projectId)).waitFor();
  assert.equal(await recoveredPage.getByText("original-only.png", { exact: true }).count(), 0);
  await recoveredPage.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        Storage.prototype.setItem = original;
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return original.call(this, name, value);
    };
  }, "spatia.assignment.source:" + actor);
  await recovery
    .getByRole("button", { name: "Use this recovered source project", exact: true })
    .click();
  await recovery
    .getByRole("alert")
    .filter({ hasText: "could not preserve the recovered source" })
    .waitFor();
  assert.equal((await head(second, actor)).state, "unacknowledged");
  assert.equal(loseAck, true, "Storage failure must not send an ACK");
  assert.equal(
    await recoveredPage.evaluate(
      (key) => localStorage.getItem(key),
      "spatia.assignment.source:" + actor,
    ),
    null,
  );
  await recovery
    .getByRole("button", { name: "Use this recovered source project", exact: true })
    .click();
  await recoveredPage
    .getByRole("status")
    .filter({
      hasText: "Using explicitly recovered source project: Cross-profile recovered source",
    })
    .waitFor();
  const acknowledged = await head(second, actor);
  assert.deepEqual(acknowledged, {
    operationId: lost.body.operationId,
    state: "ready",
    receipt: null,
  });
  const listed = await (
    await second.request.get(origin + "/api/v1/projects?archived=false&limit=20")
  ).json();
  assert.equal(listed.items.filter((item) => item.projectId === lost.receipt.projectId).length, 1);
  assert.equal(listed.items.length, 1);
  assert.equal(
    creations,
    1,
    "A clean profile recovers the committed result without a second create POST",
  );
  assert.equal(assignments, 0, "Explicit source selection does not assign it to students");
  const firstStage = { creations, assignments };
  const adopted = await recoveredPage.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    "spatia.assignment.source:" + actor,
  );
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.receipt.projectId, lost.receipt.projectId);
  await recoveredPage.reload();
  await recoveredPage
    .getByRole("status")
    .filter({
      hasText: "Using explicitly recovered source project: Cross-profile recovered source",
    })
    .waitFor();
  assert.equal(await recoveredPage.getByLabel("Choose cover image", { exact: true }).count(), 0);
  assert.equal(creations, 1);
  assert.equal(assignments, 0);
  await recoveredPage.getByLabel("Project title").fill("Recovered source assignment");
  await recoveredPage.getByLabel("Project description").fill("Assign the original durable source.");
  await recoveredPage.getByLabel("Project instructions").fill("Use the recovered original image.");
  await recoveredPage.getByLabel(/^Due date/).fill("2035-12-01");
  const recoveredClass = recoveredPage.getByRole("combobox", { name: /^Class/ });
  if (await recoveredClass.evaluate((element) => element.tagName === "SELECT"))
    await recoveredClass.selectOption(selected.id);
  else {
    await recoveredClass.click();
    await recoveredPage.getByRole("option", { name: selected.name, exact: true }).click();
  }
  await recoveredPage
    .getByRole("checkbox", { name: new RegExp(process.env.SPATIA_TEST_STUDENT) })
    .check();
  const assigning = recoveredPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/assignments") &&
      response.request().method() === "POST",
  );
  void assigning.catch(() => {});
  await recoveredPage.getByRole("button", { name: "Create project", exact: true }).click();
  const assigned = await assigning;
  assert.equal(assigned.status(), 201);
  assert.equal(assigned.request().postDataJSON().sourceProjectId, lost.receipt.projectId);
  assert.equal((await assigned.json()).projects.length, 1);
  await recoveredPage.waitForURL(origin + "/home");
  assert.equal(
    await recoveredPage.evaluate(
      (key) => localStorage.getItem(key),
      "spatia.assignment.source:" + actor,
    ),
    null,
  );
  assert.equal(creations, 1, "Reload and assignment must retain the original single source POST");
  assert.equal(assignments, 1);
  console.log(
    JSON.stringify({
      operationId: lost.body.operationId,
      projectId: lost.receipt.projectId,
      firstStage,
      creations,
      assignments,
      state: acknowledged.state,
    }),
  );
  await second.close();
} finally {
  await browser?.close();
  await server.close();
}
