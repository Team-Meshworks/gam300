import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const projectId = process.env.SPATIA_REVIEW_PROJECT;
const classId = process.env.SPATIA_REVIEW_CLASS;
const unavailable = process.env.SPATIA_REVIEW_UNAVAILABLE === "true";
assert.ok(
  projectId && classId && process.env.SPATIA_REVIEW_STUDENT && process.env.SPATIA_REVIEW_EDUCATOR,
);
const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "silent" });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = "https://127.0.0.1:" + address.port;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const errors = [];
  async function login(userName) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/login");
    await page.getByLabel("Username", { exact: true }).fill(userName);
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByRole("heading", { name: /You.re signed in/ }).waitFor();
    await page.goto(origin + "/review");
    await page.getByLabel("Class", { exact: true }).selectOption(classId);
    await page.getByLabel("Assignment", { exact: true }).selectOption({ label: "Assignment" });
    await page.locator("#review-student").selectOption(projectId);
    await page.getByText("Current server-saved revision:", { exact: false }).waitFor();
    return page;
  }
  const student = await login(process.env.SPATIA_REVIEW_STUDENT);
  await student.getByRole("checkbox").check();
  await student.getByRole("button", { name: "Submit for review", exact: true }).click();
  await student.getByRole("button", { name: "Cancel", exact: true }).click();
  const before = await student.evaluate(
    async (id) => (await (await fetch("/api/projects/" + id + "/submissions")).json()).items,
    projectId,
  );
  assert.equal(before.length, 0, "Cancellation creates no database submission");
  await student.getByRole("button", { name: "Submit for review", exact: true }).click();
  await student.getByRole("button", { name: "Confirm submission", exact: true }).click();
  if (unavailable) {
    await student.getByRole("alert").filter({ hasText: "assets are not ready" }).waitFor();
    const after = await student.evaluate(
      async (id) => (await (await fetch("/api/projects/" + id + "/submissions")).json()).items,
      projectId,
    );
    assert.equal(after.length, 0);
  } else {
    await student.getByText("Late submission", { exact: true }).waitFor();
    const teacher = await login(process.env.SPATIA_REVIEW_EDUCATOR);
    await teacher
      .getByRole("textbox", { name: "Feedback", exact: true })
      .fill("The saved exhibition is ready.");
    await teacher.getByRole("button", { name: "Approve submission", exact: true }).click();
    await teacher.getByRole("button", { name: "Confirm decision", exact: true }).click();
    await teacher.getByText("Approved for this revision", { exact: true }).waitFor();
    await student.getByRole("button", { name: "Refresh status", exact: true }).click();
    await student
      .getByRole("region", { name: "Educator feedback" })
      .getByText("The saved exhibition is ready.", { exact: true })
      .waitFor();
    assert.equal(
      await student.getByRole("button", { name: "Publish project", exact: true }).isDisabled(),
      true,
    );
    const saveStatus = await student.evaluate(async (id) => {
      const saved = await (await fetch("/api/projects/" + id)).json();
      const token = await (await fetch("/api/auth/csrf")).json();
      const response = await fetch("/api/projects/" + id, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": token.requestToken },
        body: JSON.stringify({
          expectedRevision: saved.revision,
          clientMutationId: crypto.randomUUID(),
          document: { ...saved.document, title: "Newer saved draft" },
        }),
      });
      return response.status;
    }, projectId);
    assert.equal(saveStatus, 200);
    await teacher.getByRole("button", { name: "Refresh status", exact: true }).click();
    await teacher
      .getByText("Historical submission — not approval of the current revision", { exact: true })
      .waitFor();
    await teacher
      .getByRole("region", { name: "Submitted content" })
      .getByText("Student draft", { exact: true })
      .waitFor();
    await teacher
      .getByRole("textbox", { name: "Feedback", exact: true })
      .fill("A newer revision needs review.");
    assert.equal(
      await teacher.getByRole("button", { name: "Approve submission", exact: true }).isDisabled(),
      true,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Real HTTPS review UI and PostgreSQL checks passed; unavailable assets=" + unavailable,
  );
} finally {
  await browser?.close();
  await server.close();
}
