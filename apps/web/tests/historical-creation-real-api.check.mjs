import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";

const selected = process.env.SPATIA_TEST_PROJECT;
const sameName = process.env.SPATIA_TEST_SAME_NAME;
const archived = process.env.SPATIA_TEST_ARCHIVED;
const hidden = process.env.SPATIA_TEST_HIDDEN;
const classroom = process.env.SPATIA_TEST_CLASS;
const otherClass = process.env.SPATIA_TEST_OTHER_CLASS;
assert.ok(selected && sameName && archived && hidden && classroom && otherClass);
const server = await createServer({ server: { port: 0 }, logLevel: "silent" });
await server.listen();
const origin = "https://127.0.0.1:" + server.httpServer.address().port;
let browser;
try {
  browser = await launchBrowser({ target: origin });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Singapore",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin + "/login");
  await page.getByLabel("Username", { exact: true }).fill(process.env.SPATIA_TEST_EDUCATOR);
  await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL(origin + "/home");
  const actor = (await (await context.request.get(origin + "/api/v1/auth/session")).json()).userId;
  const paths = [];
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/") && request.method() !== "GET") paths.push(path);
  });
  const row = (picker, id) =>
    picker.getByRole("button", { name: "Review project " + id, exact: true }).locator("..");
  const review = (picker, id) =>
    picker.getByRole("button", { name: "Review project " + id, exact: true });
  assert.equal(
    await page.getByText("Find an existing project", { exact: true }).count(),
    0,
    "Normal facilitator Home keeps recovery tools out of the project list",
  );

  const sessionKey = "spatia:uncertain-project-creation:" + actor;
  await page.evaluate((key) => sessionStorage.setItem(key, "1"), sessionKey);
  await page.reload();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  const historical = page.getByRole("region", {
    name: "Historical project recovery",
  });
  const projects = historical.getByRole("region", {
    name: "Choose existing project",
  });
  await review(projects, archived).waitFor();
  for (const id of [selected, sameName, archived]) {
    assert.match(await row(projects, id).textContent(), /Older gallery/);
  }
  assert.match(await row(projects, archived).textContent(), /archived/i);
  assert.equal(await row(projects, hidden).count(), 0);
  await review(projects, archived).click();
  await projects.getByRole("button", { name: "Open this existing project", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("projectId") === archived);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey), null);
  assert.deepEqual(paths, []);

  await page.goto(origin + "/classes");
  const classList = page.getByRole("combobox", { name: "Class", exact: true });
  await classList.click();
  for (const id of [classroom, otherClass]) {
    const option = page.locator(`[role="option"][value="${id}"]`);
    await option.waitFor({ state: "attached" });
    assert.match(await option.textContent(), /^Recovered class \(\d+\)$/);
    assert.ok(!(await option.textContent()).includes(id), "Class IDs stay internal");
  }
  assert.equal(await page.getByRole("option", { selected: true }).count(), 0);
  const [roster] = await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/v1/classes/" + classroom + "/roster",
    ),
    page.locator(`[role="option"][value="${classroom}"]`).click(),
  ]);
  assert.equal(roster.status(), 200);
  const members = (await roster.json()).items;
  assert.ok(members.some((member) => member.userName === process.env.SPATIA_TEST_STUDENT));
  assert.deepEqual(paths, []);

  const sourceKey = "spatia.assignment.source:" + actor;
  await page.goto(origin + "/new-project");
  assert.equal(
    await page.getByRole("button", { name: "Use an existing project", exact: true }).count(),
    0,
  );
  const sources = page.getByRole("region", { name: "Choose existing project" });
  const oldAttempt = {
    attemptId: randomUUID(),
    title: "Older gallery",
    environmentAssetId: "",
  };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: sourceKey,
    value: oldAttempt,
  });
  await page.reload();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await review(sources, selected).waitFor();
  assert.match(await row(sources, sameName).textContent(), /Older gallery/);
  assert.ok(await review(sources, archived).isDisabled());
  assert.equal(await row(sources, hidden).count(), 0);
  await review(sources, selected).click();
  await sources
    .getByRole("button", {
      name: "Use this existing source project",
      exact: true,
    })
    .click();
  await page.getByRole("status").filter({ hasText: "Older gallery" }).waitFor();
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), sourceKey), {
    actorId: actor,
    selectedExisting: {
      projectId: selected,
      title: "Older gallery",
      revision: 7,
    },
  });
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Older gallery" }).waitFor();
  assert.equal(await page.getByLabel("Choose cover image", { exact: true }).count(), 0);
  assert.deepEqual(
    paths,
    [],
    "Review, selection and reload must never issue a create or acknowledge a fictional receipt",
  );

  await page.getByLabel("Project title").fill("Assignment from an existing gallery");
  await page.getByLabel("Project description").fill("Reuse the selected gallery.");
  await page.getByLabel("Project instructions").fill("Start with the selected revision.");
  await page.getByLabel(/^Due date/).fill("2035-12-01");
  const classControl = page.getByRole("combobox", { name: /^Class/ });
  if (await classControl.evaluate((element) => element.tagName === "SELECT"))
    await classControl.selectOption(classroom);
  else {
    await classControl.click();
    if (process.env.SPATIA_RECOVERY_SCREENSHOT)
      await page.screenshot({ path: process.env.SPATIA_RECOVERY_SCREENSHOT });
    const optionBounds = await page.getByRole("option").evaluateAll((options) =>
      options.map((option) => {
        const row = option.getBoundingClientRect();
        const label = option.querySelector("[data-control-label]").getBoundingClientRect();
        return {
          text: option.textContent,
          top: row.top,
          bottom: row.bottom,
          labelTop: label.top,
          labelBottom: label.bottom,
        };
      }),
    );
    for (const option of optionBounds)
      assert.ok(
        option.labelTop >= option.top - 0.5 && option.labelBottom <= option.bottom + 0.5,
        "Wrapped option labels must stay inside their own clickable rows: " +
          JSON.stringify(option),
      );
    await page.locator(`[role="option"][value="${classroom}"]`).click();
  }
  await page
    .getByRole("checkbox", {
      name: new RegExp(process.env.SPATIA_TEST_STUDENT),
    })
    .check();
  const path = "/api/v1/classes/" + classroom + "/assignments";
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === path && res.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create project", exact: true }).click(),
  ]);
  assert.equal(response.status(), 201);
  const intent = response.request().postDataJSON();
  assert.equal(intent.sourceProjectId, selected);
  assert.equal(intent.sourceRevision, 7);
  await page.waitForURL(origin + "/home");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), sourceKey), null);
  assert.deepEqual(paths, [path]);

  const saved = {
    receipt: {
      projectId: sameName,
      revision: 0,
      updatedAt: "2026-11-05T00:00:00Z",
      archived: false,
    },
    imageKey: "formerly-confirmed-cover",
  };
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: sourceKey,
    value: saved,
  });
  await page.goto(origin + "/new-project");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await page.getByRole("button", { name: "Review previous project", exact: true }).click();
  await review(sources, sameName).waitFor();
  assert.equal(await review(sources, selected).count(), 0);
  assert.equal(await review(sources, archived).count(), 0);
  await review(sources, sameName).click();
  await sources
    .getByRole("button", {
      name: "Use this existing source project",
      exact: true,
    })
    .click();
  await page.getByRole("status").filter({ hasText: "Older gallery" }).waitFor();
  assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), sourceKey), {
    actorId: actor,
    selectedExisting: {
      projectId: sameName,
      title: "Older gallery",
      revision: 2,
    },
  });
  assert.deepEqual(paths, [path]);
  await context.close();
} finally {
  await browser?.close();
  await server.close();
}
