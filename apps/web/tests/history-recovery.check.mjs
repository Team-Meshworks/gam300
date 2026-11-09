import { launchBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import { serveProject } from "./authoring-project-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const browser = await launchBrowser({
  target: process.argv[2] ?? "http://127.0.0.1:5173/",
  args: ["--enable-unsafe-swiftshader"],
});
// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Clicking a card only picks it, Add is what places it
async function addAsset(page, name) {
  if (name === "Starter room") {
    if (await page.locator(".asset-picker").count()) await page.keyboard.press("Escape");
    const overview = page.getByRole("button", { name: "Third person", exact: true });
    if ((await overview.getAttribute("aria-pressed")) !== "true") await overview.click();
    await page.getByRole("button", { name: "Rooms", exact: true }).click();
    await page
      .getByRole("group", { name: "Rooms options", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
  } else {
    await openLibrary(page);
    await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
  await placeAtRoomCenter(page);
  await page.locator(".viewport-stage[data-placing-asset]").waitFor({ state: "hidden" });
}

async function reloadRecovery(page) {
  await page.reload();
  const recover = page.getByRole("button", { name: "Recover my edits", exact: true });
  await recover.waitFor();
  await recover.click();
}

try {
  // An isolated context keeps the author's real browser drafts untouched.
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = process.argv[2] ?? "http://127.0.0.1:5173/";
  const project = await serveProject(page, origin);
  await page.addInitScript((projectId) => {
    window.testRecoveryScope = { accountId: "00000000-0000-4000-8000-000000000001", projectId };
  }, new URL(project.url).searchParams.get("projectId"));
  await page.goto(project.url);
  await addAsset(page, "Starter room");
  await addAsset(page, "Sample crate");
  const rows = page.locator(".object-row");
  async function waitForRecovery(count, futureCount, hotspots = 0, interactions = 0) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await page.evaluate(
        async ({ count, futureCount, hotspots, interactions }) => {
          const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
          const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
          const result = await loadRecoverySession(
            new Map(assets.map((asset) => [asset.id, asset.kind])),
            window.testRecoveryScope,
          );
          return (
            result.ok &&
            result.value?.document.scenes[0].objects.length === count &&
            result.value.document.scenes[0].hotspots.length === hotspots &&
            result.value.document.scenes[0].interactions.length === interactions &&
            result.value.history?.future.length === futureCount
          );
        },
        { count, futureCount, hotspots, interactions },
      );
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Recovery history did not reach the expected edit");
  }

  // Capture the starting state so Undo is checked independently of the default spawn position
  const originalPosition = await page.getByLabel("Selected position").textContent();

  // No more move buttons, so nudge through the Position panel then go back to the tree
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Sample crate transform X (m)", exact: true });
  await field.fill(String(Number(await field.inputValue()) + 0.25));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.keyboard.press("Control+d");
  assert.equal(await rows.count(), 2);
  const duplicateId = await rows.last().getAttribute("data-object-id");
  await page.keyboard.press("Control+z");
  assert.equal(await rows.count(), 1);
  await waitForRecovery(1, 1);
  await reloadRecovery(page);
  await page.getByRole("button", { name: "Redo", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1);
  await rows.first().click();
  await page.keyboard.press("Control+y");
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.last().getAttribute("data-object-id"), duplicateId);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert.equal(await page.getByLabel("Selected position").textContent(), originalPosition);
  await page.keyboard.press("Control+z");
  assert.equal(await rows.count(), 0);
  await waitForRecovery(0, 3);
  await reloadRecovery(page);
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await rows.count(), 1);
  await addAsset(page, "Sample crate");
  assert.equal(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true);
  await waitForRecovery(2, 0);

  // Attachments and rules must survive automatic backups and share the object's undo order.
  await page.getByRole("button", { name: "Add Hotspot", exact: true }).click();
  await waitForRecovery(2, 0, 1, 0);
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  const hotspotId = await page.getByLabel("Interaction 1 hotspot", { exact: true }).inputValue();
  await waitForRecovery(2, 0, 1, 1);
  await reloadRecovery(page);
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 2);
  await rows.last().locator(".hotspot-indicator").waitFor();
  const attachedObjectId = await rows.last().getAttribute("data-object-id");
  await rows.last().click();
  await page.keyboard.press("Delete");
  assert.equal(await rows.count(), 1);
  const deletionNotice = await page.locator(".draft-feedback").textContent();
  assert.match(deletionNotice, /1 related rule\b/i, "Deletion reports the affected rule count");
  assert.match(deletionNotice, /undo restores/i, "Deletion explains how to restore the rule");
  await waitForRecovery(1, 0, 0, 0);
  await reloadRecovery(page);
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await rows.last().getAttribute("data-object-id"), attachedObjectId);
  await rows.last().locator(".hotspot-indicator").waitFor();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interaction 1 hotspot", { exact: true }).inputValue(),
    hotspotId,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await page.locator(".interaction-card").count(), 0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await waitForRecovery(1, 4, 0, 0);
  await reloadRecovery(page);
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1);
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await rows.last().getAttribute("data-object-id"), attachedObjectId);
  await rows.last().locator(".hotspot-indicator").waitFor();
  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await page.getByLabel("Interaction 1 hotspot", { exact: true }).inputValue(),
    hotspotId,
  );
  await waitForRecovery(2, 1, 1, 1);

  const storageResults = await page.evaluate(async () => {
    const { loadRecoverySession, applySaveRecoverySession } =
      await import("/persistence/local-drafts.ts");
    const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const kinds = new Map(assets.map((a) => [a.id, a.kind]));
    // Exercise the active session first, then retain the older draft compatibility checks
    const active = await loadRecoverySession(kinds, window.testRecoveryScope);
    if (!active.ok || !active.value?.history) throw new Error("Missing active history");
    const { revision, ...session } = active.value;
    const badSession = await applySaveRecoverySession(
      { ...session, history: { ...session.history, current: [] } },
      revision,
      kinds,
      new IndexedDBDraftDatabase(),
      window.testRecoveryScope,
    );
    if (badSession.ok) throw new Error("Mismatched history was accepted");
    const unchangedSession = await loadRecoverySession(kinds, window.testRecoveryScope);
    if (JSON.stringify(unchangedSession) !== JSON.stringify(active))
      throw new Error("Rejected history changed recovery");
    async function editStored(change) {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("vthere-local-drafts", 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("session", "readwrite");
          const store = tx.objectStore("session");
          const read = store.get([
            "account",
            window.testRecoveryScope.accountId,
            window.testRecoveryScope.projectId,
          ]);
          read.onsuccess = () => {
            change(read.result);
            store.put(read.result, [
              "account",
              window.testRecoveryScope.accountId,
              window.testRecoveryScope.projectId,
            ]);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    }
    const afterRejectedSave = await loadRecoverySession(kinds, window.testRecoveryScope);
    await editStored((record) => {
      record.history.version = 99;
    });
    const damaged = await loadRecoverySession(kinds, window.testRecoveryScope);
    await editStored((record) => {
      delete record.history;
    });
    const legacy = await loadRecoverySession(kinds, window.testRecoveryScope);
    return {
      rejected: !badSession.ok,
      unchanged: JSON.stringify(afterRejectedSave) === JSON.stringify(active),
      damagedSceneKept: damaged.ok && !!damaged.value?.historyWarning && !damaged.value?.history,
      legacyOpens:
        legacy.ok && !!legacy.value && !legacy.value.historyWarning && !legacy.value.history,
    };
  });
  assert.deepEqual(storageResults, {
    rejected: true,
    unchanged: true,
    damagedSceneKept: true,
    legacyOpens: true,
  });

  // Seed an actual asset-pipeline backup in another isolated profile. The active
  // scene is second in the document, so first-scene assumptions cannot pass here.
  const fixture = JSON.parse(
    readFileSync(
      new URL("../editor/fixtures/asset-pipeline-document-history.json", import.meta.url),
      "utf8",
    )
      .replaceAll('"room"', '"test-room-v1"')
      .replaceAll('"crate"', '"test-crate-v1"'),
  );
  const compatibilityPage = await browser.newPage();
  compatibilityPage.on("pageerror", (error) => errors.push(error.message));
  const compatibilityProject = await serveProject(compatibilityPage, origin, fixture.document);
  await compatibilityPage.addInitScript((projectId) => {
    window.testRecoveryScope = { accountId: "00000000-0000-4000-8000-000000000001", projectId };
  }, fixture.document.projectId);
  await compatibilityPage.goto(compatibilityProject.url);
  await compatibilityPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await compatibilityPage.evaluate(async (fixture) => {
    const { applySaveRecoverySession } = await import("/persistence/local-drafts.ts");
    const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
    const { createDocumentStore } = await import("/document-store.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const kinds = new Map(assets.map((a) => [a.id, a.kind]));
    const store = createDocumentStore(assets);
    const loaded = store.loadProject(JSON.stringify(fixture.document), kinds, fixture.history);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const result = await applySaveRecoverySession(
      {
        document: loaded.value,
        history: fixture.history,
        serverSave: { revision: 0, confirmedJson: JSON.stringify(loaded.value), pending: null },
      },
      0,
      kinds,
      new IndexedDBDraftDatabase(),
      window.testRecoveryScope,
    );
    if (!result.ok) throw new Error(result.error.message);
  }, fixture);
  await reloadRecovery(compatibilityPage);
  const activeId = fixture.history.documents.activeSceneId;
  const activeObjectId = fixture.document.scenes[1].objects[0].id;
  const activeRow = compatibilityPage.locator(`.object-row[data-object-id="${activeObjectId}"]`);
  await activeRow.waitFor();
  await activeRow.click();
  await compatibilityPage.getByRole("button", { name: "Add Hotspot", exact: true }).click();
  await activeRow.locator(".hotspot-indicator").waitFor();
  await compatibilityPage.getByRole("button", { name: "Interaction", exact: true }).click();
  await compatibilityPage.getByRole("button", { name: "+ Add Interaction", exact: true }).click();
  const target = await compatibilityPage
    .getByLabel("Interaction 1 hotspot", { exact: true })
    .inputValue();
  async function waitForActiveScene(name, hotspotCount, ruleCount) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      // Await IndexedDB explicitly; an async predicate is itself truthy to DOM polling.
      const ready = await compatibilityPage.evaluate(
        async ({ activeId, name, hotspotCount, ruleCount }) => {
          const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
          const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
          const result = await loadRecoverySession(
            new Map(assets.map((a) => [a.id, a.kind])),
            window.testRecoveryScope,
          );
          if (!result.ok || !result.value?.history?.documents) return false;
          const scene = result.value.document.scenes.find((s) => s.id === activeId);
          return (
            result.value.history.documents.activeSceneId === activeId &&
            scene?.name === name &&
            scene.hotspots.length === hotspotCount &&
            scene.interactions.length === ruleCount &&
            result.value.document.scenes[0].hotspots.length === 0
          );
        },
        { activeId, name, hotspotCount, ruleCount },
      );
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Recovery did not persist the expected active scene and interactions");
  }
  await waitForActiveScene("Exhibit", 1, 1);
  await reloadRecovery(compatibilityPage);
  await activeRow.waitFor();
  for (let i = 0; i < 3; i++)
    await compatibilityPage.getByRole("button", { name: "Undo", exact: true }).click();
  await waitForActiveScene("Annex", 0, 0);
  for (let i = 0; i < 3; i++)
    await compatibilityPage.getByRole("button", { name: "Redo", exact: true }).click();
  await compatibilityPage.getByRole("button", { name: "Interaction", exact: true }).click();
  assert.equal(
    await compatibilityPage.getByLabel("Interaction 1 hotspot", { exact: true }).inputValue(),
    target,
  );
  await waitForActiveScene("Exhibit", 1, 1);
  await compatibilityPage.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: persisted Undo/Redo shortcuts, object/hotspot/rule restoration, asset-pipeline active-scene recovery, stable IDs, empty-scene redo, branching, atomic rejection and damaged or missing history fallback",
  );
} finally {
  await browser.close();
}
