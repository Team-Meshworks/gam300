import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { launchBrowser } from "./browser-security.mjs";
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" });
let browser;
const doc = JSON.parse(
  await readFile(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
doc.scenes = [
  {
    ...doc.scenes[0],
    environmentAssetId: null,
    objects: [],
    groups: [],
    zones: [],
    viewpoints: [],
    rules: [],
  },
];
const projectId = doc.projectId,
  actor = "22222222-2222-4222-8222-222222222222",
  student = "33333333-3333-4333-8333-333333333333",
  classId = "44444444-4444-4444-8444-444444444444",
  assignmentId = "55555555-5555-4555-8555-555555555555";
let releaseSave;
const saveGate = new Promise((resolve) => (releaseSave = resolve));
let saved = 0;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await launchBrowser({ target: origin });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status });
    if (path === "/api/v1/auth/session")
      return reply({
        userId: actor,
        orgId: "66666666-6666-4666-8666-666666666666",
        displayName: "Teacher",
        role: "Educator",
        mustChangePassword: false,
        developmentAssetsAllowed: false,
      });
    if (path === "/api/v1/auth/csrf") return reply({ requestToken: "csrf" });
    if (path === "/api/v1/assets" || path === `/api/v1/projects/${projectId}/assets`)
      return reply([]);
    if (path === `/api/v1/classes/${classId}/assignments/${assignmentId}`)
      return reply({
        assignmentId,
        title: "Museum",
        description: "",
        instructions: "",
        dueAtUnixSeconds: 1793581199,
        projects: [{ projectId, studentId: student, studentName: "Student One" }],
      });
    if (path.endsWith("/progress-reviews")) {
      if (req.method() === "POST") {
        const b = req.postDataJSON();
        saved++;
        await saveGate;
        return reply(
          {
            id: b.reviewId,
            feedback: b.feedback,
            revision: b.expectedRevision,
            createdAt: "2026-11-02T01:00:00Z",
          },
          201,
        );
      }
      return reply({ items: [], nextCursor: null });
    }
    if (path.endsWith("/submissions")) return reply({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`)
      return reply({
        projectId,
        revision: 0,
        document: doc,
        permissions: { canEdit: true, canManage: true, canPublish: true },
      });
    return reply({}, 404);
  });
  await page.route("**/home?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Home fixture</title>" }),
  );
  const url =
    origin +
    "/?" +
    new URLSearchParams({ projectId, classId, assignmentId, studentId: student, review: "1" });
  await page.goto(url);
  await page.getByText("Scene ready", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Leave editor" }).click();
  const dialog = page.getByRole("dialog", { name: "Review submission" });
  await dialog.waitFor();
  assert.equal(page.url(), url, "review opens before navigation");
  await dialog.getByLabel("Your review").fill("Useful feedback");
  await dialog.getByRole("button", { name: "Save review" }).click();
  await page
    .waitForFunction(
      () => document.querySelector("dialog")?.textContent?.includes("Saving") || false,
      { timeout: 3000 },
    )
    .catch(() => {});
  assert.equal(saved, 1);
  assert.equal(page.url(), url, "save remains on editor until confirmation");
  releaseSave();
  await page.waitForURL("**/home?**");
  assert.equal(new URL(page.url()).searchParams.get("assignmentId"), assignmentId);
  console.log("Editor exit waits for confirmed review save");
} finally {
  releaseSave?.();
  await browser?.close();
  await server.close();
}
