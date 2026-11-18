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
  const clockServer = await serveProject(page, url);
  await page.goto(clockServer.url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await add(page, "Starter room");
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  await page.getByLabel("Interaction 1 when", { exact: true }).selectOption("time-elapsed");
  const ruleMs = 2000;
  await page.getByLabel("Interaction 1 after", { exact: true }).selectOption(String(ruleMs / 1000));
  const previewButton = page.getByRole("button", { name: "Preview", exact: true });
  await page.evaluate(() => {
    const frames = { active: true, gaps: [], startedAt: 0 };
    window.slowFrames = frames;
    let previous = performance.now();
    function occupyFrame(now) {
      if (!frames.active) return;
      frames.gaps.push(now - previous);
      previous = now;
      const end = performance.now() + 230;
      while (performance.now() < end) {}
      requestAnimationFrame(occupyFrame);
    }
    const ready = new MutationObserver(() => {
      if (
        Array.from(document.querySelectorAll('[role="status"]')).some(
          (status) => status.textContent.trim() === "Exhibition ready",
        )
      ) {
        ready.disconnect();
        frames.startedAt = Date.now();
        previous = performance.now();
        requestAnimationFrame(occupyFrame);
      }
    });
    ready.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const fired = page.waitForEvent("dialog", { timeout: 6000 });
  await previewButton.click();
  const dialog = await fired;
  const firedAt = Date.now();
  assert.equal(dialog.message(), "hi");
  await dialog.accept();
  const frames = await page.evaluate(() => {
    const state = window.slowFrames;
    state.active = false;
    return { startedAt: state.startedAt, slow: state.gaps.filter((gap) => gap >= 200).length };
  });
  const elapsed = firedAt - frames.startedAt;
  const longFrames = frames.slow;
  assert.ok(longFrames >= 3, `Expected several slow frames, observed ${longFrames}`);
  assert.ok(
    elapsed >= ruleMs - 200 && elapsed < ruleMs + 1500,
    `Two-second rule fired after ${elapsed} ms`,
  );
  await page.getByRole("button", { name: "Exit preview", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Exhibition ready" }).waitFor();
  const alert = page.waitForEvent("dialog", { timeout: ruleMs * 6 }).then(async (dialog) => {
    const at = Date.now();
    const message = dialog.message();
    await dialog.accept();
    return { at, message };
  });
  const startedAt = await page.evaluate(async (visibleMs) => {
    const start = Date.now();
    const deadline = performance.now() + visibleMs;
    await new Promise((resolve) => {
      function frame(now) {
        if (now >= deadline) resolve();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    return start;
  }, ruleMs / 5);
  const hiddenAt = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const at = Date.now();
    document.dispatchEvent(new Event("visibilitychange"));
    return at;
  });
  const deadline = AbortSignal.timeout(ruleMs + 500);
  const noDialog = new Promise((resolve) =>
    deadline.addEventListener("abort", () => resolve(null), { once: true }),
  );
  assert.equal(
    await Promise.race([alert, noDialog]),
    null,
    "Hidden time must not advance the rule",
  );
  const resumedAt = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const at = Date.now();
    document.dispatchEvent(new Event("visibilitychange"));
    return at;
  });
  const resumedAlert = await alert;
  assert.equal(resumedAlert.message, "hi");
  assert.ok(resumedAt - hiddenAt >= ruleMs, "The hidden interval must cross the rule deadline");
  const afterResume = resumedAlert.at - resumedAt;
  const activeTime = hiddenAt - startedAt + afterResume;
  assert.ok(
    afterResume >= 1300 && afterResume < ruleMs + 500,
    `Rule fired ${afterResume} ms after resuming`,
  );
  assert.ok(
    activeTime >= ruleMs - 150 && activeTime < ruleMs + 800,
    `Rule fired after ${activeTime} ms of visible time`,
  );
  await context.close();
  console.log("PASS: real scene clock excludes simulated hidden intervals and resumes correctly");
  console.log(`PASS: actual scene loop fired after ${elapsed} ms across ${longFrames} slow frames`);
} finally {
  await browser.close();
}
