import { launchBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
async function add(page, name) {
  // Rooms now use the dedicated placement tray rather than the object library
  if (name === "Starter room") {
    if (await page.locator(".asset-picker").count()) await page.keyboard.press("Escape");
    const overview = page.getByRole("button", { name: "Third person", exact: true });
    if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await placeAtRoomCenter(page);
    return;
  }

  if (!(await page.locator(".asset-picker").count()))
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
}
async function backup(page, expectedUrl, count) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(
      async ({ expectedUrl, count }) => {
        const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const result = await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])));
        const scene = result.ok && result.value?.document?.scenes[0];
        return (
          scene &&
          scene.interactions.length === count &&
          scene.interactions[0]?.do.url === expectedUrl
        );
      },
      { expectedUrl, count },
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Recovery did not reach expected URL/count: " + (await page.locator("body").innerText()),
  );
}
try {
  for (const version of [1, 2]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    await add(page, "Starter room");
    await add(page, "Sample crate");
    if (version === 2) {
      await page.locator(".environment-row").press("F2");
      await page.getByRole("textbox", { name: /^Rename / }).fill("Draft gallery");
      await page.getByRole("textbox", { name: /^Rename / }).press("Enter");
    }
    await page.locator("[data-object-id]").first().click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    await page.keyboard.press("Control+d");
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    const ids = await page
      .locator("[data-object-id]")
      .evaluateAll((rows) => rows.map((r) => r.dataset.objectId));
    assert.equal(ids.length, 2);
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
    const targets = page.getByLabel("Interaction 1 hotspot", { exact: true });
    const choices = await targets
      .locator("option")
      .evaluateAll((options) => options.map((o) => ({ label: o.textContent, value: o.value })));
    assert.equal(
      new Set(choices.map((c) => c.label)).size,
      2,
      "Duplicate target labels are distinct",
    );
    for (let index = 0; index < 2; index++) {
      await targets.selectOption(choices[index].value);
      await page.getByRole("button", { name: "Locate Interaction 1 target", exact: true }).click();
      await page.getByRole("button", { name: "Scene tree", exact: true }).click();
      assert.equal(
        await page.locator(`[data-object-id="${ids[index]}"]`).getAttribute("aria-pressed"),
        "true",
      );
      await page.getByRole("button", { name: "Interaction", exact: true }).click();
    }
    await page.getByLabel("Interaction 1 do", { exact: true }).selectOption("open-link");
    await page.getByText("Not saved", { exact: true }).waitFor();
    await backup(page, "", 1); // Wait past the actual two-second debounce, leaving the URL empty.
    const restoredVersion = await page.evaluate(async () => {
      const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      return (await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])))).value.document
        .schemaVersion;
    });
    assert.equal(restoredVersion, version);
    await page.getByText("Untitled project", { exact: true }).click();
    await page.getByRole("button", { name: "New", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await confirmation.waitFor();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await page.getByText("Reopened your last project", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    assert.equal(await page.getByLabel("Interaction 1 link", { exact: true }).inputValue(), "");
    assert.deepEqual(
      await targets.locator("option").allTextContents(),
      choices.map((c) => c.label),
    );
    await page.getByText("Not saved", { exact: true }).waitFor();
    await page
      .getByLabel("Interaction 1 link", { exact: true })
      .fill("https://example.com/corrected");
    await backup(page, "https://example.com/corrected", 1);
    await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
    await backup(page, "https://example.com/corrected", 2);
    await page.reload();
    await page.getByText("Reopened your last project", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    assert.equal(await page.locator(".interaction-card").count(), 2);
    assert.equal(
      await page.getByLabel("Interaction 1 link", { exact: true }).inputValue(),
      "https://example.com/corrected",
    );
    if (version === 2) {
      const mixed = await page.evaluate(async () => {
        const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const result = await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])));
        return result.value.document;
      });
      mixed.scenes[0].hotspots[0].objectId = mixed.scenes[0].hotspots[0].objectId.toUpperCase();
      await page.locator("#project-import").setInputFiles({
        name: "mixed-reference.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(mixed)),
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Don’t Save", exact: true })
        .click();
      await page.getByText("Project opened", { exact: true }).waitFor();
      if (!(await targets.count()))
        await page.getByRole("button", { name: "Interaction", exact: true }).click();
      await targets.selectOption(choices[0].value);
      await page.getByRole("button", { name: "Locate Interaction 1 target", exact: true }).click();
      await page.getByRole("button", { name: "Scene tree", exact: true }).click();
      assert.equal(
        await page.locator('[data-object-id="' + ids[0] + '"]').getAttribute("aria-pressed"),
        "true",
        "Locate resolves case-insensitive object references",
      );
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS: v${version} empty-link backup, dirty confirmation, reload, correction, continued backup; duplicate labels and Locate`,
    );
  }

  // A released document at the byte limit must survive both Open and browser recovery.
  const boundaryContext = await browser.newContext();
  const boundaryPage = await boundaryContext.newPage();
  const document = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  document.schemaVersion = 2;
  document.title = "Boundary recovery";
  const scene = document.scenes[0];
  delete scene.hotspots;
  delete scene.interactions;
  Object.assign(scene, { groups: [], zones: [], viewpoints: [], rules: [] });
  scene.startCamera.rotation = [0, 0, 0, 1];
  for (const object of scene.objects) {
    object.transform.rotation = [0, 0, 0, 1];
    Object.assign(object, { parentId: null, visible: true, components: [] });
  }
  const runs = [];
  for (let index = 0; index < 10; index++) {
    const object = {
      ...structuredClone(scene.objects[0]),
      id: "80000000-0000-4000-8000-" + String(index).padStart(12, "0"),
      components: [],
    };
    for (let at = 0; at < 8; at++) {
      const run = { text: "", marks: [] };
      runs.push(run);
      object.components.push({
        id: "90000000-0000-4000-8000-" + String(index * 8 + at).padStart(12, "0"),
        type: "text",
        runs: [run],
        caption: "",
      });
    }
    scene.objects.push(object);
  }
  let remaining = 5 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(document));
  for (const run of runs) {
    const length = Math.min(65536, remaining);
    run.text = "x".repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  const buffer = Buffer.from(JSON.stringify(document));
  assert.equal(buffer.length, 5 * 1024 * 1024);
  await boundaryPage.goto(url);
  await boundaryPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await boundaryPage
    .locator("#project-import")
    .setInputFiles({ name: "boundary.json", mimeType: "application/json", buffer });
  await boundaryPage.getByText("Project opened", { exact: true }).waitFor();
  await boundaryPage.reload();
  await boundaryPage.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.equal(await boundaryPage.locator("[data-object-id]").count(), 12);
  await boundaryContext.close();
  console.log("PASS: exact 5 MiB v2 file opens and reloads through the real session hook");

  const context = await browser.newContext();
  // Exercise the real scene loop at roughly four frames per second.
  await context.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => setTimeout(() => request(callback), 250);
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await add(page, "Starter room");
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 when", { exact: true }).selectOption("time-elapsed");
  await page.getByLabel("Interaction 1 after", { exact: true }).selectOption("2");
  const started = Date.now();
  const fired = page.waitForEvent("dialog", { timeout: 3500 });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const dialog = await fired;
  const elapsed = Date.now() - started;
  assert.equal(dialog.message(), "hi");
  await dialog.accept();
  assert.ok(elapsed >= 1800 && elapsed < 3500, `Two-second rule fired after ${elapsed} ms`);
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  const hiddenAlerts = [];
  page.on("dialog", async (dialog) => {
    hiddenAlerts.push(Date.now());
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(hiddenAlerts.length, 0, "Hidden time must not advance the rule");
  const resumed = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  while (!hiddenAlerts.length && Date.now() - resumed < 2500)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hiddenAlerts.length, 1);
  assert.ok(hiddenAlerts[0] - resumed >= 1300, "Visible time remaining is preserved");
  await context.close();
  console.log("PASS: real scene clock excludes simulated hidden intervals and resumes correctly");
  console.log(`PASS: actual scene loop at 250-ms frames fired after ${elapsed} ms`);
} finally {
  await browser.close();
}
