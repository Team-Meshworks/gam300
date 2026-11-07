import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./browser-security.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:5185/";
const browser = await launchBrowser({ target: url, args: ["--enable-unsafe-swiftshader"] });
await mkdir("test-results/audio-library", { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.previewAudios = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.src.includes(".m4a") && !window.previewAudios.includes(this))
        window.previewAudios.push(this);
      return play.call(this);
    };
  });
  await page.goto(url);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const button = (name, root = page) => root.getByRole("button", { name, exact: true });
  await button("Third person").click();
  await button("Rooms").click();
  await button(
    "Starter room",
    page.getByRole("group", { name: "Rooms options", exact: true }),
  ).click();
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 350 } });
  // Read the real recovery record so assertions wait for the same persistence used after reload
  async function document() {
    return page.evaluate(async () => {
      const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
      const { loadRecoverySession } = await import("/persistence/recovery-session.ts");
      const result = await loadRecoverySession(
        new Map(assets.map((asset) => [asset.id, asset.kind])),
      );
      return result.ok ? result.value?.document : null;
    });
  }
  async function saved(check) {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const value = await document();
      if (value && check(value)) return value;
      await page.waitForTimeout(50);
    }
    throw Error("Audio edit did not reach recovery");
  }
  await saved((doc) => doc.scenes.length === 1);
  await button("Asset library").click();
  const reference = await page.locator(".asset-picker").boundingBox();
  await button("Close asset library").click();
  async function open(mode) {
    await button("Audio").click();
    const popup = page.getByRole("group", { name: "Audio options", exact: true });
    assert.equal(await popup.getByRole("button").count(), 3);
    await button(mode, popup).click();
  }
  const dialog = page.getByRole("dialog", { name: "Audio", exact: true });
  let requested = 0;
  page.on("request", (r) => {
    if (r.url().includes(".m4a")) requested++;
  });
  // BGM is the only authorable category and browsing must not download every track
  await open("BGM");
  assert.equal(await dialog.locator(".asset-card").count(), 7);
  const box = await dialog.boundingBox();
  assert.ok(
    Math.abs(reference.width - box.width) < 1 && Math.abs(reference.height - box.height) < 1,
    "Library dimensions must match",
  );
  assert.equal(requested, 0, "Do not preload audio catalogue");
  // Exercise real media playback and ensure pause/resume reuses one player
  await button("Preview Ethereal Calm", dialog).click();
  await page.waitForFunction(() =>
    window.previewAudios.some((audio) => !audio.paused && audio.currentTime > 0.1),
  );
  await button("Pause Ethereal Calm", dialog).click();
  assert.equal(await page.evaluate(() => window.previewAudios[0].paused), true);
  for (let i = 0; i < 2; i++) {
    const before = await page.evaluate(() => window.previewAudios[0].currentTime);
    await button("Preview Ethereal Calm", dialog).click();
    assert.equal(
      await page.evaluate(() => window.previewAudios[0].paused),
      false,
      "One click resumes audio",
    );
    assert.ok(
      (await page.evaluate(() => window.previewAudios[0].currentTime)) >= before,
      "Resume must preserve playback position",
    );
    await button("Pause Ethereal Calm", dialog).click();
    assert.equal(
      await page.evaluate(() => window.previewAudios[0].paused),
      true,
      "One click pauses audio",
    );
  }
  assert.equal(
    await page.evaluate(() => window.previewAudios.length),
    1,
    "Repeated pause/resume must reuse the player",
  );
  await button("Preview Mystic Harp", dialog).click();
  await page.waitForFunction(
    () => window.previewAudios.length === 2 && !window.previewAudios[1].paused,
  );
  assert.equal(await page.evaluate(() => window.previewAudios[0].paused), true);
  await button("Ethereal Calm", dialog).click();
  // Search and favourites only narrow the library; mobile sizing must not introduce horizontal overflow
  await button("Favourite Ethereal Calm", dialog).click();
  const filter = dialog.getByRole("combobox", { name: "Filter audio", exact: true });
  await filter.click();
  await dialog.getByRole("option", { name: "Favourites", exact: true }).click();
  assert.equal(await dialog.locator(".asset-card").count(), 1);
  await filter.click();
  await dialog.getByRole("option", { name: "BGM", exact: true }).click();
  await dialog.screenshot({ path: "test-results/audio-library/background-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.screenshot({ path: "test-results/audio-library/background-mobile.png" });
  const overflow = await dialog.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    nodes: [...el.querySelectorAll("*")]
      .filter((node) => node.getBoundingClientRect().right > el.getBoundingClientRect().right)
      .map((node) => [node.className, node.getBoundingClientRect().width])
      .slice(0, 10),
  }));
  assert.equal(overflow.scroll <= overflow.width, true, JSON.stringify(overflow));
  await dialog.screenshot({ path: "test-results/audio-library/background-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1024 });
  // Adding closes the modal, stops its preview and creates a recoverable scene audio identity
  await button("Add", dialog).click();
  assert.equal(
    await page.evaluate(() =>
      window.previewAudios.every((audio) => audio.paused && !audio.getAttribute("src")),
    ),
    true,
  );
  let doc = await saved((doc) => doc.scenes[0].audio?.length === 1);
  assert.equal(doc.scenes[0].objects.length, 0);
  const original = doc.scenes[0].audio[0];
  await button("Ethereal Calm").click();
  assert.equal(await dialog.count(), 0, "Selecting hierarchy audio must not reopen the library");
  assert.equal(await button("Ethereal Calm").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".scene-audio-remove").count(), 0);
  await page.keyboard.press("Delete");
  await saved((doc) => doc.scenes[0].audio.length === 0);
  await button("Undo").click();
  await saved((doc) => doc.scenes[0].audio[0]?.id === original.id);
  // Unavailable audio types remain discoverable without changing the draft or opening a library
  await button("Audio").click();
  const audioTools = page.getByRole("group", { name: "Audio options", exact: true });
  for (const name of ["Sound effects", "Payphone audio"]) {
    const tool = button(name, audioTools);
    assert.equal(await tool.getAttribute("aria-disabled"), "true");
    await tool.hover();
    assert.equal(await page.locator(".tool-tip", { hasText: "Coming soon" }).isVisible(), true);
    await tool.dispatchEvent("click");
    assert.equal(await dialog.count(), 0);
  }
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  doc = await document();
  assert.equal(doc.scenes[0].audio[0].id, original.id);
  assert.equal(doc.scenes[0].objects.length, 0);
  await button("Ethereal Calm").click();
  await page.keyboard.press("Delete");
  await saved((doc) => doc.scenes[0].audio.length === 0);
  await button("Undo").click();
  await saved((doc) => doc.scenes[0].audio.length === 1);
  // Reload returns to first person; use the overview so the annotation target is fully visible
  const overview = button("Third person");
  if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
  // Connect an added track through the normal hotspot editor and exercise the accessible preview path
  await button("Asset library").click();
  await button("Sample crate", page.locator(".asset-picker")).click();
  await button("Add", page.locator(".asset-picker")).click();
  await page.locator(".viewport-stage").click({ position: { x: 600, y: 350 } });
  await page.locator(".object-row[data-object-id]").first().click();
  // Seed a checked annotation through import so this panel regression is independent of camera placement
  const annotated = await saved((doc) => doc.scenes[0].objects.length > 0);
  annotated.scenes[0].hotspots = [
    { id: crypto.randomUUID(), objectId: annotated.scenes[0].objects[0].id, position: [0, 1, 0] },
  ];
  await page.locator("#project-import").setInputFiles({
    name: "audio-hotspot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(annotated)),
  });
  const discard = page
    .locator(".project-confirmation")
    .getByRole("button", { name: "Don’t Save", exact: true });
  await discard.click();
  await page.locator(".project-confirmation").waitFor({ state: "hidden" });
  await saved((doc) => doc.scenes[0].hotspots.length === 1);
  await button("Interaction").click();
  await button("+ Add Interaction").click();
  await page.getByLabel("Interaction 1 do", { exact: true }).selectOption("play-audio");
  await page.getByLabel("Interaction 1 audio", { exact: true }).selectOption(original.id);
  await saved((doc) => doc.scenes[0].interactions[0]?.do.mediaId === original.id);
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await button("Preview").click();
  const target = page.locator(".preview-targets button").first();
  await target.click();
  await page.waitForFunction(() =>
    window.previewAudios.some((audio) => !audio.paused && audio.src.includes("ethereal-calm")),
  );
  await button("Exit preview").click();
  assert.equal(
    await page.evaluate(() => window.previewAudios.every((audio) => audio.paused)),
    true,
  );
  await page.locator(".object-row[data-object-id]").first().click();
  assert.equal(
    await page
      .locator(".scene-tree")
      .getByRole("button", { name: /^Remove hotspot from / })
      .count(),
    0,
  );
  await button("Interaction").click();
  await page.locator(".interaction-list").waitFor();
  await page.getByRole("button", { name: /^Remove hotspot from / }).click();
  await saved(
    (doc) => doc.scenes[0].hotspots.length === 0 && doc.scenes[0].interactions.length === 0,
  );
  await button("Undo").click();
  await saved(
    (doc) =>
      doc.scenes[0].hotspots.length === 1 &&
      doc.scenes[0].interactions[0]?.do.mediaId === original.id,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: audio library, playback cleanup, BGM hierarchy, hotspot links, deletion, Undo/Redo and recovery",
  );
} finally {
  await browser.close();
}
