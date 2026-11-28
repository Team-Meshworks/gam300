import { launchBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { blankProject, openSavedProject, serveProject } from "./authoring-project-fixture.mjs";
import { waitForStoredDraft } from "./stored-draft.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
async function recover(page) {
  const dialog = page.getByRole("dialog", { name: "Recover your changes?" });
  await dialog.getByRole("button", { name: "Recover changes" }).click();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
}
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
function backup(page, expectedUrl, count) {
  return waitForStoredDraft(page, () =>
    page.evaluate(
      async ({ expectedUrl, count }) => {
        const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const result = await loadRecoverySession(new Map(assets.map((a) => [a.id, a.kind])), {
          accountId: "00000000-0000-4000-8000-000000000001",
          projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        });
        const document = result.ok ? result.value?.document : null;
        const scene = document?.scenes[0];
        return scene?.interactions.length === count && scene.interactions[0]?.do.url === expectedUrl
          ? document
          : null;
      },
      { expectedUrl, count },
    ),
  ).catch(async (cause) => {
    throw new Error(
      "Recovery did not reach expected URL/count: " + (await page.locator("body").innerText()),
      { cause },
    );
  });
}
try {
  for (const version of [1, 2]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial =
      version === 1
        ? JSON.parse(
            readFileSync(
              new URL("../shared/project/fixtures/m1-project.json", import.meta.url),
              "utf8",
            ),
          )
        : structuredClone(blankProject);
    if (version === 2) initial.scenes[0].environmentAssetId = null;
    initial.scenes[0].objects = [];
    initial.scenes[0].hotspots = [];
    initial.scenes[0].interactions = [];
    const server = await serveProject(page, url, initial);
    await page.goto(server.url);
    await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    if (version === 2) await add(page, "Starter room");
    else await page.getByRole("button", { name: "Third person", exact: true }).click();
    await add(page, "Sample crate");
    if (version === 2) {
      await page.locator(".environment-row").press("F2");
      await page.getByRole("textbox", { name: /^Rename / }).fill("Draft gallery");
      await page.getByRole("textbox", { name: /^Rename / }).press("Enter");
    }
    await page.locator("[data-object-id]").first().click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    await page.locator(".hotspot-indicator").first().waitFor();
    await page.keyboard.press("Control+d");
    await page.locator("[data-object-id]").nth(1).click();
    await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
    await page
      .locator(".hotspot-indicator")
      .nth(1)
      .waitFor()
      .catch(async (error) => {
        throw new Error(`${error.message}\n${await page.locator(".scene-tree").innerHTML()}`);
      });
    const ids = await page
      .locator("[data-object-id]")
      .evaluateAll((rows) => rows.map((r) => r.dataset.objectId));
    assert.equal(ids.length, 2);
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    assert.match(
      await page.locator(".interaction-help").innerText(),
      /Touch fires when a visitor walks into the hotspot's object/,
    );
    await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
    const when = page.getByLabel("Interaction 1 when", { exact: true });
    assert.deepEqual(
      await when.locator("option").evaluateAll((options) => options.map((o) => o.value)),
      ["visitor-clicks-hotspot", "visitor-touch", "scene-starts", "time-elapsed"],
    );
    await when.selectOption("visitor-touch");
    const targets = page.getByLabel("Interaction 1 hotspot", { exact: true });
    assert.equal(await targets.isVisible(), true);
    await when.selectOption("visitor-clicks-hotspot");
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
    assert.equal((await backup(page, "", 1)).schemaVersion, version);
    await page.getByRole("button", { name: "Leave editor", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await confirmation.waitFor();
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await recover(page);
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    assert.equal(await page.getByLabel("Interaction 1 link", { exact: true }).inputValue(), "");
    assert.deepEqual(
      await targets.locator("option").allTextContents(),
      choices.map((c) => c.label),
    );
    await page
      .getByLabel("Interaction 1 link", { exact: true })
      .fill("https://example.com/corrected");
    await backup(page, "https://example.com/corrected", 1);
    await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
    const recovered = await backup(page, "https://example.com/corrected", 2);
    await page.reload();
    await recover(page);
    await page.getByRole("button", { name: "Interaction", exact: true }).click();
    assert.equal(await page.locator(".interaction-card").count(), 2);
    assert.equal(
      await page.getByLabel("Interaction 1 link", { exact: true }).inputValue(),
      "https://example.com/corrected",
    );
    if (version === 2) {
      const firstHotspot = recovered.scenes[0].hotspots[0];
      firstHotspot.objectId = firstHotspot.objectId.toUpperCase();
      server.setDocument(recovered);
      await page.reload();
      await openSavedProject(page);
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

  // A server document at the byte limit must survive account-scoped recovery.
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
  const boundaryServer = await serveProject(boundaryPage, url, document);
  await boundaryPage.goto(boundaryServer.url);
  await boundaryPage
    .getByRole("status")
    .filter({ hasText: "Scene ready" })
    .waitFor()
    .catch(async (error) => {
      throw new Error(`${error.message}\n${await boundaryPage.locator("body").innerText()}`);
    });
  await boundaryPage.evaluate(async (document) => {
    const { applySaveRecoverySession } = await import("/persistence/recovery-session.ts");
    const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const confirmedJson = JSON.stringify(document);
    document.title = "Retained boundary";
    const saved = await applySaveRecoverySession(
      { document, serverSave: { revision: 0, confirmedJson, pending: null } },
      0,
      new Map(assets.map((asset) => [asset.id, asset.kind])),
      new IndexedDBDraftDatabase(),
      { accountId: "00000000-0000-4000-8000-000000000001", projectId: document.projectId },
    );
    if (!saved.ok) throw new Error(saved.error.message);
  }, document);
  await boundaryPage.reload();
  await recover(boundaryPage);
  assert.equal(await boundaryPage.title(), "Retained boundary - Spatia");
  assert.equal(await boundaryPage.locator("[data-object-id]").count(), 12);
  await boundaryContext.close();
  console.log("PASS: exact 5 MiB v2 server project opens and recovers an account-scoped edit");

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const clockServer = await serveProject(page, url);
  await page.goto(clockServer.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await add(page, "Starter room");
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 when", { exact: true }).selectOption("time-elapsed");
  const ruleMs = 2000;
  await page.getByLabel("Interaction 1 after", { exact: true }).selectOption(String(ruleMs / 1000));
  await page.clock.pauseAt(new Date("2026-01-02T00:00:00Z"));
  const messages = [];
  page.on("dialog", async (dialog) => {
    messages.push(dialog.message());
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Preview", exact: true }).dispatchEvent("click");
  await page
    .getByRole("status")
    .filter({ hasText: "Exhibition ready" })
    .waitFor({ state: "attached" });
  const frameMs = 250;
  await page.clock.fastForward(frameMs);
  assert.deepEqual(messages, []);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(ruleMs * 2);
  assert.deepEqual(messages, [], "Four seconds hidden must not fire the two-second rule");
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  for (let elapsed = 2 * frameMs; elapsed < ruleMs; elapsed += frameMs) {
    await page.clock.fastForward(frameMs);
    assert.deepEqual(messages, [], `The rule fired early after ${elapsed} ms`);
  }
  await page.clock.fastForward(frameMs);
  assert.deepEqual(messages, ["hi"], "The rule resumes and fires after eight visible frames");
  await context.close();
  console.log("PASS: elapsed interaction counts slow preview frames and excludes hidden time");
} finally {
  await browser.close();
}
