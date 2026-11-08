import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../web/tests/browser-security.mjs";

const [origin, userName, projectId, environmentId, modelId, editorDirectory, artifactDirectory] =
  process.argv.slice(2);
const target = new URL(origin);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
assert.ok(
  userName && projectId && environmentId && modelId && editorDirectory && artifactDirectory,
);
await mkdir(artifactDirectory, { recursive: true });
const webRoot = fileURLToPath(new URL("../../web/", import.meta.url)).replaceAll("\\", "/");
const { build } = await import("../../web/node_modules/vite/dist/node/index.js");
await build({
  configFile: webRoot + "vite.config.ts",
  logLevel: "silent",
  build: { write: true, outDir: editorDirectory, emptyOutDir: false },
});
const browser = await launchBrowser({
  target: origin,
  args: ["--enable-unsafe-swiftshader"],
  verificationOutput: "stdout",
});
const contexts = [];
let page;
const errors = [];
const failedResponses = [];
const consoleErrors = [];
const projectPath = `/api/v1/projects/${projectId}`;

async function openEditor() {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1024 },
  });
  contexts.push(context);
  const next = await context.newPage();
  page = next;
  next.setDefaultTimeout(15000);
  next.on("pageerror", (error) => errors.push(error.message));
  next.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  next.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const loginPage = await next.goto(origin + "/login");
  console.log(`Login page HTTP status: ${loginPage?.status()}`);
  assert.equal(loginPage?.status(), 200);
  await next.getByLabel("Username", { exact: true }).fill(userName);
  await next.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
  await next.getByRole("button", { name: "Log in", exact: true }).click();
  await next.getByRole("link", { name: "Go to projects", exact: true }).waitFor();
  const session = await next.evaluate(async () => {
    const response = await fetch("/api/v1/auth/session", { cache: "no-store" });
    return { status: response.status, value: await response.json() };
  });
  assert.equal(session.status, 200);
  assert.equal(session.value.developmentAssetsAllowed, false);
  await next.goto(`${origin}/?projectId=${encodeURIComponent(projectId)}`);
  await next.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  return next;
}

async function readProject(current) {
  const response = await current.evaluate(async (id) => {
    const result = await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
    return { status: result.status, value: await result.json() };
  }, projectId);
  assert.equal(response.status, 200);
  return response.value;
}

function waitForSave(current) {
  return current.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname === projectPath,
  );
}

try {
  page = await openEditor();
  const thirdPerson = page.getByRole("button", { name: "Third person", exact: true });
  if ((await thirdPerson.getAttribute("aria-pressed")) !== "true") await thirdPerson.click();
  await page.getByRole("button", { name: "Rooms", exact: true }).click();
  const rooms = page.getByRole("group", { name: "Rooms options", exact: true });
  assert.equal(await rooms.getByRole("button", { name: "Starter room", exact: true }).count(), 0);
  await rooms.getByRole("button", { name: "Approved Starter room", exact: true }).click();
  let saved = waitForSave(page);
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 350 } });
  assert.equal((await saved).status(), 200);
  await page.locator('.save-state[data-state="saved"]').waitFor();
  let project = await readProject(page);
  assert.equal(
    project.document.scenes[0].environmentAssetId.toLowerCase(),
    environmentId.toLowerCase(),
  );
  assert.equal(project.document.scenes[0].objects.length, 1);
  let room = project.document.scenes[0].objects[0];
  assert.equal(room.assetId.toLowerCase(), modelId.toLowerCase());
  assert.notEqual(room.assetId, "test-room-module-v1");
  const roomId = room.id;
  const initialPosition = [...room.transform.position];
  // Room transforms snap to adjoining slots, so request the opposite side.
  const requestedX = initialPosition[0] > 5 ? -15 : 15;

  await page.locator(".scene-tree .object-row").first().click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const position = page.getByRole("textbox", { name: `${room.name} transform X (m)`, exact: true });
  await position.fill(String(requestedX));
  saved = waitForSave(page);
  await position.press("Enter");
  assert.equal((await saved).status(), 200);
  await page.locator('.save-state[data-state="saved"]').waitFor();
  project = await readProject(page);
  room = project.document.scenes[0].objects.find((object) => object.id === roomId);
  assert.ok(room);
  const movedPosition = [...room.transform.position];
  assert.ok(Math.hypot(...movedPosition.map((value, axis) => value - initialPosition[axis])) > 1);

  const rotation = page.getByRole("textbox", { name: `${room.name} rotation Y (°)`, exact: true });
  await rotation.fill("90");
  saved = waitForSave(page);
  await rotation.press("Enter");
  assert.equal((await saved).status(), 200);
  await page.locator('.save-state[data-state="saved"]').waitFor();
  project = await readProject(page);
  room = project.document.scenes[0].objects.find((object) => object.id === roomId);
  assert.ok(room);
  assert.ok(Math.abs(Math.abs(room.transform.rotation[1]) - Math.sin(Math.PI / 4)) < 1e-5);
  assert.equal(room.assetId.toLowerCase(), modelId.toLowerCase());
  assert.equal(JSON.stringify(project.document).includes("test-room-module-v1"), false);
  await page.screenshot({
    path: path.join(artifactDirectory, "01-transformed.png"),
    animations: "disabled",
  });
  await page.context().close();

  page = await openEditor();
  await page.locator(".scene-tree .object-row").first().click();
  await page.getByRole("button", { name: "Position", exact: true }).click();
  assert.ok(
    Math.abs(
      Number(
        await page
          .getByRole("textbox", {
            name: `${room.name} transform X (m)`,
            exact: true,
          })
          .inputValue(),
      ) - movedPosition[0],
    ) < 0.01,
  );
  assert.ok(
    Math.abs(
      Number(
        await page
          .getByRole("textbox", {
            name: `${room.name} rotation Y (°)`,
            exact: true,
          })
          .inputValue(),
      ) - 90,
    ) < 0.01,
  );
  const reopened = await readProject(page);
  const reopenedRoom = reopened.document.scenes[0].objects.find((object) => object.id === roomId);
  assert.ok(reopenedRoom);
  assert.equal(reopenedRoom.assetId.toLowerCase(), modelId.toLowerCase());
  reopenedRoom.transform.position.forEach((value, axis) =>
    assert.ok(Math.abs(value - movedPosition[axis]) < 1e-6),
  );
  assert.ok(Math.abs(Math.abs(reopenedRoom.transform.rotation[1]) - Math.sin(Math.PI / 4)) < 1e-5);
  assert.equal(JSON.stringify(reopened.document).includes("test-room-module-v1"), false);
  await page.screenshot({
    path: path.join(artifactDirectory, "02-reopened.png"),
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "production adjoining room saved and reopened with approved UUID, position and rotation",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      "Browser diagnostics:",
      JSON.stringify({
        url: page.url(),
        title: await page.title().catch(() => ""),
        body: (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 1200),
        errors,
        consoleErrors,
        failedResponses,
      }),
    );
    await page
      .screenshot({ path: path.join(artifactDirectory, "failure.png"), animations: "disabled" })
      .catch(() => {});
  }
  throw error;
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  await browser.close();
}
