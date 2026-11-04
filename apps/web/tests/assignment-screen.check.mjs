import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:5182/ui-preview/assignment-test.html";
const browser = await launchBrowser({ target: baseUrl });
const context = await browser.newContext({ timezoneId: "Asia/Singapore", locale: "en-GB" });
let saved;
const requests = [];
try {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/session")
      return json({ userId: "teacher", displayName: "Teacher", role: "Educator", orgId: "school" });
    if (path === "/api/auth/csrf") return json({ requestToken: "token" });
    if (path === "/api/classes")
      return json({ items: [{ id: "class", name: "Class" }], nextCursor: null });
    if (path === "/api/projects")
      return json({
        items: [
          { projectId: "source", title: "Source", revision: 3, permissions: { canManage: true } },
        ],
        nextCursor: null,
      });
    if (path === "/api/classes/class/eligible-students")
      return json({
        items: [
          { userId: "alice", userName: "Alice", enrolled: true },
          { userId: "bob", userName: "Bob", enrolled: true },
          { userId: "outsider", userName: "Outsider", enrolled: false },
        ],
        nextCursor: null,
      });
    if (path === "/api/classes/class/assignments" && request.method() === "POST") {
      requests.push(request.postDataJSON());
      if (!saved) {
        saved = requests[0];
        return route.abort("failed");
      }
      assert.deepEqual(requests.at(-1), saved);
      return json({
        assignmentId: saved.requestId,
        projects: [
          { studentId: "alice", projectId: "a" },
          { studentId: "bob", projectId: "b" },
        ],
      });
    }
    if (saved && path === `/api/classes/class/assignments/${saved.requestId}`)
      return json({
        assignmentId: saved.requestId,
        title: saved.title,
        description: saved.description,
        instructions: saved.instructions,
        dueAtUnixSeconds: saved.dueAtUnixSeconds,
        projects: [
          { studentId: "alice", projectId: "a" },
          { studentId: "bob", projectId: "b" },
        ],
      });
    throw new Error(`Unexpected API request: ${path}`);
  });
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto(baseUrl), second.goto(baseUrl)]);
  async function fill(page) {
    await page.getByLabel("Source project").selectOption("source");
    await page.getByLabel("Project title").fill("Assignment");
    await page.getByLabel("Project description").fill("Description");
    await page.getByLabel("Project instructions").fill("Instructions");
    await page.getByLabel("Due date and time").fill("2026-12-01T15:30");
    await page.getByLabel(/^Class/).selectOption("class");
    await page.getByRole("checkbox", { name: /Alice/ }).check();
    await page.getByRole("checkbox", { name: /Bob/ }).check();
    assert.equal(await page.getByRole("checkbox", { name: /Outsider/ }).count(), 0);
  }
  await fill(first);
  await fill(second);
  await first.getByRole("button", { name: "Create project" }).click();
  await first.getByRole("button", { name: "Retry same assignment" }).waitFor();
  await second.getByRole("button", { name: "Create project" }).click();
  await second.getByRole("button", { name: "Retry same assignment" }).waitFor();
  assert.equal(requests.length, 1);
  await first.close();
  await second.reload();
  await second.getByRole("button", { name: "Retry same assignment" }).click();
  await second.getByRole("heading", { name: "Assignment" }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(saved.dueAtUnixSeconds, Date.parse("2026-12-01T07:30:00Z") / 1000);
  assert.equal(
    await second.evaluate(() => localStorage.getItem("spatia.assignment.pending:teacher")),
    null,
  );
  console.log("Assignment screen retry and cross-tab checks passed");
} catch (error) {
  await browser.close();
  throw error;
} finally {
  await context.close();
}

async function recoveryScenario(kind) {
  const isolated = await browser.newContext({ timezoneId: "Asia/Singapore", locale: "en-GB" });
  const posts = [];
  let projectsFail = false;
  try {
    await isolated.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/api/auth/session")
        return json({
          userId: "teacher",
          displayName: "Teacher",
          role: "Educator",
          orgId: "school",
        });
      if (path === "/api/auth/csrf") return json({ requestToken: "token" });
      if (path === "/api/classes")
        return json({ items: [{ id: "class", name: "Class" }], nextCursor: null });
      if (path === "/api/projects")
        return projectsFail
          ? json({}, 503)
          : json({
              items: [
                {
                  projectId: "source",
                  title: "Source",
                  revision: 3,
                  permissions: { canManage: true },
                },
              ],
              nextCursor: null,
            });
      if (path === "/api/classes/class/eligible-students")
        return json({
          items: [{ userId: "alice", userName: "Alice", enrolled: true }],
          nextCursor: null,
        });
      if (path === "/api/classes/class/assignments" && request.method() === "POST") {
        posts.push(request.postDataJSON());
        if (kind !== "initial-413" && posts.length === 1) return route.abort("failed");
        return json({}, 413);
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    const page = await isolated.newPage();
    await page.goto(baseUrl);
    await page.getByLabel("Source project").selectOption("source");
    await page.getByLabel("Project title").fill("Assignment");
    await page.getByLabel("Project description").fill("Description");
    await page.getByLabel("Project instructions").fill("Instructions");
    await page.getByLabel("Due date and time").fill("2026-12-01T15:30");
    await page.getByLabel(/^Class/).selectOption("class");
    await page.getByRole("checkbox", { name: /Alice/ }).check();
    await page.getByRole("button", { name: "Create project" }).click();
    if (kind === "initial-413") {
      await page.getByRole("alert").waitFor({ timeout: 5000 });
      assert.equal(
        await page.evaluate(() => localStorage.getItem("spatia.assignment.pending:teacher")),
        null,
      );
      assert.equal(await page.getByLabel("Project title").inputValue(), "Assignment");
      await page.getByLabel("Project title").fill("Corrected assignment");
      assert.equal(await page.getByLabel("Project title").inputValue(), "Corrected assignment");
    } else {
      await page.getByRole("button", { name: "Retry same assignment" }).waitFor();
      const pending = await page.evaluate(() =>
        localStorage.getItem("spatia.assignment.pending:teacher"),
      );
      assert.ok(pending);
      if (kind === "choices-fail") {
        projectsFail = true;
        await page.reload();
      }
      await Promise.all([
        page.waitForResponse(
          (item) => item.url().endsWith("/assignments") && item.status() === 413,
        ),
        page.getByRole("button", { name: "Retry same assignment" }).click({ timeout: 5000 }),
      ]);
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], posts[0]);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("spatia.assignment.pending:teacher")),
        pending,
      );
      await page.getByRole("button", { name: "Retry same assignment" }).waitFor();
    }
    console.log(`${kind} recovery check passed`);
  } finally {
    await isolated.close();
  }
}

try {
  for (const scenario of process.argv[3]
    ? [process.argv[3]]
    : ["initial-413", "choices-fail", "replay-413"])
    await recoveryScenario(scenario);
} finally {
  await browser.close();
}
