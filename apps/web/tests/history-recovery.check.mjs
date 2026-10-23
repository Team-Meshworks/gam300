import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  // An isolated context keeps the author's real browser drafts untouched.
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.getByRole("button", { name: "Add test-room", exact: true }).click();
  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  const rows = page.locator(".object-row");
  async function waitForRecovery(count, futureCount) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await page.evaluate(
        async ({ count, futureCount }) => {
          const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
          const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
          const result = await loadRecoverySession(
            new Map(assets.map((asset) => [asset.id, asset.kind])),
          );
          return (
            result.ok &&
            result.value?.document.scenes[0].objects.length === count &&
            result.value.history?.future.length === futureCount
          );
        },
        { count, futureCount },
      );
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Recovery history did not reach the expected edit");
  }

  // No more move buttons, so nudge through the Position panel then go back to the tree
  await page.getByRole("button", { name: "Position", exact: true }).click();
  const field = page.getByRole("textbox", { name: "test-crate 1 transform X (m)", exact: true });
  await field.fill(String(Number(await field.inputValue()) + 0.25));
  await field.press("Enter");
  await page.getByRole("button", { name: "Scene tree", exact: true }).click();
  await page.keyboard.press("Control+d");
  assert.equal(await rows.count(), 2);
  const duplicateId = await rows.last().getAttribute("data-object-id");
  await page.keyboard.press("Control+z");
  assert.equal(await rows.count(), 1);
  await waitForRecovery(1, 1);
  await page.reload();
  await page.getByRole("button", { name: "Redo", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".object-row").length === 1);
  await rows.first().click();
  await page.keyboard.press("Control+y");
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.last().getAttribute("data-object-id"), duplicateId);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert.match(await page.getByLabel("Selected position").textContent(), /X 0\.00/);
  await page.keyboard.press("Control+z");
  assert.equal(await rows.count(), 0);
  await waitForRecovery(0, 3);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal(await rows.count(), 1);
  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true);
  await waitForRecovery(2, 0);

  const storageResults = await page.evaluate(async () => {
    const { loadLatestLocalDraft, saveLocalDraft, loadRecoverySession, saveRecoverySession } =
      await import("/persistence/local-drafts.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const kinds = new Map(assets.map((a) => [a.id, a.kind]));
    // Exercise the active session first, then retain the older draft compatibility checks
    const active = await loadRecoverySession(kinds);
    if (!active.ok || !active.value?.history) throw new Error("Missing active history");
    const { revision, ...session } = active.value;
    const badSession = await saveRecoverySession(
      { ...session, history: { ...session.history, current: [] } },
      revision,
      kinds,
    );
    if (badSession.ok) throw new Error("Mismatched history was accepted");
    const unchangedSession = await loadRecoverySession(kinds);
    if (JSON.stringify(unchangedSession) !== JSON.stringify(active))
      throw new Error("Rejected history changed recovery");
    const seeded = await saveLocalDraft(
      {
        project: session.document,
        history: session.history,
        expectedStorageRevision: 0,
        localEditSequence: 0,
      },
      kinds,
    );
    if (!seeded.ok) throw new Error(seeded.error.message);
    const recovered = await loadLatestLocalDraft(kinds);
    if (!recovered.ok || !recovered.value?.history) throw new Error("Missing recovered history");
    const draft = recovered.value;
    const mismatch = await saveLocalDraft(
      {
        project: draft.document,
        history: { ...draft.history, current: [] },
        expectedStorageRevision: draft.localStorageRevision,
        localEditSequence: draft.localEditSequence + 1,
      },
      kinds,
    );
    async function editStored(change) {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("vthere-local-drafts", 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("drafts", "readwrite");
          const store = tx.objectStore("drafts");
          const read = store.get(["local", draft.projectId]);
          read.onsuccess = () => {
            change(read.result);
            store.put(read.result);
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
    const afterRejectedSave = await loadLatestLocalDraft(kinds);
    await editStored((record) => {
      record.history.version = 99;
    });
    const damaged = await loadLatestLocalDraft(kinds);
    await editStored((record) => {
      delete record.history;
    });
    const legacy = await loadLatestLocalDraft(kinds);
    return {
      rejected: !mismatch.ok,
      unchanged: JSON.stringify(afterRejectedSave) === JSON.stringify(recovered),
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
  assert.deepEqual(errors, []);
  console.log(
    "PASS: persisted Undo/Redo shortcuts, stable IDs, empty-scene redo, branching, atomic rejection, damaged-history fallback and legacy drafts",
  );
} finally {
  await browser.close();
}
