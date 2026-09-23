import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  // Fresh browser context keeps these writes away from the author's saved drafts
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const results = await page.evaluate(async (project) => {
    const { saveLocalDraft, loadLocalDraft } = await import("/persistence/local-drafts.ts");
    const assets = new Map([
      ["test-room-v1", "environment"],
      ["test-crate-v1", "model"],
    ]);
    const request = { project, expectedStorageRevision: 0, localEditSequence: 1 };
    async function readStored() {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open("vthere-local-drafts", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("drafts", "readonly");
          const read = transaction.objectStore("drafts").get(["local", project.projectId]);
          transaction.oncomplete = () => {
            database.close();
            resolve(read.result);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      });
    }

    const missing = await loadLocalDraft(project.projectId, assets);
    const first = await saveLocalDraft(request, assets);
    const stored = await readStored();
    const loaded = await loadLocalDraft(project.projectId.toUpperCase(), assets);
    const invalid = await saveLocalDraft({ ...request, project: { schemaVersion: 99 } }, assets);
    const stale = await saveLocalDraft(request, assets);
    const afterRejections = await readStored();

    // An aborted transaction must report failure even if put returned a request
    const originalPut = IDBObjectStore.prototype.put;
    let aborted;
    try {
      IDBObjectStore.prototype.put = function (...args) {
        const result = originalPut.apply(this, args);
        this.transaction.abort();
        return result;
      };
      aborted = await saveLocalDraft({ ...request, expectedStorageRevision: 1 }, assets);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const afterAbort = await readStored();

    // Competing connections both expect revision one; only one may advance it
    const competing = await Promise.all([
      saveLocalDraft({ ...request, expectedStorageRevision: 1, localEditSequence: 2 }, assets),
      saveLocalDraft({ ...request, expectedStorageRevision: 1, localEditSequence: 3 }, assets),
    ]);
    const winner = await readStored();
    const olderEdit = await saveLocalDraft({ ...request, expectedStorageRevision: 2 }, assets);
    const afterOlderEdit = await readStored();

    const originalOpen = IDBFactory.prototype.open;
    let unavailable;
    let unavailableRead;
    try {
      IDBFactory.prototype.open = () => {
        throw new DOMException("Storage disabled", "SecurityError");
      };
      unavailable = await saveLocalDraft(request, assets);
      unavailableRead = await loadLocalDraft(project.projectId, assets);
    } finally {
      IDBFactory.prototype.open = originalOpen;
    }
    async function replaceStored(record) {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open("vthere-local-drafts", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction("drafts", "readwrite");
          transaction.objectStore("drafts").put(record);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      });
    }
    const damaged = [
      { ...winner, document: "{" },
      { ...winner, document: JSON.stringify({ ...project, schemaVersion: 99 }) },
      { ...winner, document: winner.document.replace("test-crate-v1", "missing-model") },
      {
        ...winner,
        document: JSON.stringify({ ...project, projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      },
      { ...winner, localStorageRevision: -1 },
      { ...winner, savedAt: "invalid date" },
    ];
    const rejectedRecords = [];
    for (const record of damaged) {
      await replaceStored(record);
      rejectedRecords.push({
        record,
        result: await loadLocalDraft(project.projectId, assets),
        retained: await readStored(),
      });
    }
    await replaceStored(winner);
    return {
      missing,
      loaded,
      unavailableRead,
      rejectedRecords,
      first,
      stored,
      invalid,
      stale,
      afterRejections,
      aborted,
      afterAbort,
      competing,
      winner,
      olderEdit,
      afterOlderEdit,
      unavailable,
      project,
    };
  }, fixture);

  assert.deepEqual(results.missing, { ok: true, value: null });
  assert.equal(results.loaded.ok, true);
  assert.deepEqual(results.loaded.value.document, fixture);
  assert.equal(results.loaded.value.localStorageRevision, 1);
  assert.equal(results.loaded.value.localEditSequence, 1);
  assert.equal(results.loaded.value.savedAt, results.stored.savedAt);
  assert.equal(results.unavailableRead.ok, false);
  for (const { record, result, retained } of results.rejectedRecords) {
    assert.equal(result.ok, false);
    assert.deepEqual(retained, record, "Rejected records stay in storage");
  }
  // Reload the page to discard JavaScript memory before reading the committed draft
  await page.reload();
  const reopened = await page.evaluate(async (id) => {
    const { loadLocalDraft } = await import("/persistence/local-drafts.ts");
    return loadLocalDraft(
      id,
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
      ]),
    );
  }, fixture.projectId);
  assert.equal(reopened.ok, true);
  assert.deepEqual(reopened.value.document, fixture);
  assert.equal(reopened.value.localStorageRevision, 2);
  assert.equal(results.first.ok, true);
  assert.equal(results.stored.localStorageRevision, 1);
  assert.equal(results.stored.localEditSequence, 1);
  assert.deepEqual(JSON.parse(results.stored.document), fixture);
  assert.equal(results.invalid.ok, false);
  assert.equal(results.stale.ok, false);
  assert.deepEqual(results.afterRejections, results.stored);
  assert.equal(results.aborted.ok, false);
  assert.deepEqual(results.afterAbort, results.stored);
  assert.equal(results.competing.filter((result) => result.ok).length, 1);
  assert.equal(results.winner.localStorageRevision, 2);
  assert.equal(results.olderEdit.ok, false);
  assert.deepEqual(results.afterOlderEdit, results.winner);
  assert.equal(results.unavailable.ok, false);
  assert.deepEqual(results.project, fixture);
  // Exercise the author-facing controls against the draft written above
  const ready = page.getByRole("status").filter({ hasText: "Scene ready" });
  const recover = page.getByRole("button", { name: "Recover local draft", exact: true });
  const save = page.getByRole("button", { name: "Save locally", exact: true });
  const label = page.locator(".save-state");
  const rows = page.locator(".object-row");
  await ready.waitFor();
  await page.locator(".draft-menu summary").click();
  await recover.click();
  await page.getByText("Recovered local draft from this device", { exact: true }).waitFor();
  assert.equal(await rows.count(), 2);
  assert.equal(await label.textContent(), "Saved on this device");
  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  assert.equal(await label.textContent(), "Not saved");
  const savedIds = await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId));
  await page.locator(".draft-menu summary").click();
  await save.click();
  await page.getByText("Local draft saved on this device", { exact: true }).waitFor();
  assert.equal(await label.textContent(), "Saved on this device");
  await page.reload();
  await ready.waitFor();
  await page.locator(".draft-menu summary").click();
  await recover.click();
  await page.getByText("Recovered local draft from this device", { exact: true }).waitFor();
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    savedIds,
  );

  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException("Test quota failure", "QuotaExceededError");
    };
  });
  await page.locator(".draft-menu summary").click();
  await save.click();
  await page.getByText("Local save failed", { exact: true }).waitFor();
  assert.equal(await rows.count(), 4, "Failed saves keep in-memory edits");
  await page.locator(".draft-menu summary").click();
  await recover.click();
  await page.getByText("Recovered local draft from this device", { exact: true }).waitFor();
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    savedIds,
  );

  // Reopening the sample reuses its project ID even when a browser save already exists
  await page.reload();
  await ready.waitFor();
  await page.getByRole("button", { name: "Open sample project", exact: true }).click();
  await page.getByRole("button", { name: "Add test-crate", exact: true }).click();
  assert.ok(!(await page.locator(".draft-feedback").textContent()).endsWith("."));
  const replacementIds = await rows.evaluateAll((items) =>
    items.map((item) => item.dataset.objectId),
  );
  page.removeAllListeners("dialog");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator(".draft-menu summary").click();
  await save.click();
  await page.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "Not saved",
  );
  const retained = await page.evaluate(async (id) => {
    const { loadLocalDraft } = await import("/persistence/local-drafts.ts");
    return loadLocalDraft(
      id,
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
      ]),
    );
  }, fixture.projectId);
  assert.equal(retained.ok, true);
  assert.deepEqual(
    retained.value.document.scenes[0].objects.map((object) => object.id),
    savedIds,
  );
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    replacementIds,
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator(".draft-menu summary").click();
  await save.click();
  await page.getByText("Local draft saved on this device", { exact: true }).waitFor();
  assert.equal(await label.textContent(), "Saved on this device");
  await page.reload();
  await ready.waitFor();
  await page.locator(".draft-menu summary").click();
  await recover.click();
  await page.getByText("Recovered local draft from this device", { exact: true }).waitFor();
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    replacementIds,
  );

  // Export a moved scene before saving again so the file must contain the live edit
  const expectedExport = await page.evaluate(async (id) => {
    const { loadLocalDraft } = await import("/persistence/local-drafts.ts");
    const result = await loadLocalDraft(
      id,
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
      ]),
    );
    return result.value.document;
  }, fixture.projectId);
  await rows.first().click();
  await page
    .getByRole("button", {
      name: `Move ${expectedExport.scenes[0].objects[0].name} X plus 0.25 metres`,
      exact: true,
    })
    .click();
  expectedExport.scenes[0].objects[0].transform.position[0] += 0.25;
  await page.locator(".draft-menu summary").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "vthere-Crate-layout.json");
  const exportedText = readFileSync(await download.path(), "utf8");
  assert.deepEqual(JSON.parse(exportedText), expectedExport);
  assert.equal(
    await label.textContent(),
    "Not saved",
    "Export leaves browser-save status unchanged",
  );
  const freshPage = await browser.newPage();
  await freshPage.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await freshPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await freshPage.locator(".draft-menu summary").click();
  const choosing = freshPage.waitForEvent("filechooser");
  await freshPage.getByRole("button", { name: "Import", exact: true }).click();
  const chooser = await choosing;
  const projectFile = {
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(exportedText),
  };
  await chooser.setFiles(projectFile);
  await freshPage.getByText("Project imported", { exact: true }).waitFor();
  assert.equal(
    await freshPage.getByRole("button", { name: "Undo", exact: true }).isDisabled(),
    true,
  );
  await freshPage.locator(".draft-menu summary").click();
  const roundTripDownload = freshPage.waitForEvent("download");
  await freshPage.getByRole("button", { name: "Export", exact: true }).click();
  assert.deepEqual(
    JSON.parse(readFileSync(await (await roundTripDownload).path(), "utf8")),
    expectedExport,
  );

  // Invalid imports keep the current objects, selection and placement history
  await freshPage.getByRole("button", { name: "Add test-crate", exact: true }).click();
  const beforeImport = await freshPage
    .locator(".object-row")
    .evaluateAll((items) =>
      items.map((item) => [item.dataset.objectId, item.getAttribute("aria-pressed")]),
    );
  let confirmations = 0;
  freshPage.on("dialog", (dialog) => {
    confirmations += 1;
    return dialog.dismiss();
  });
  for (const invalid of [
    "{",
    JSON.stringify({ ...expectedExport, schemaVersion: 999 }),
    exportedText.replace("test-crate-v1", "unknown-asset"),
    " ".repeat(5 * 1024 * 1024 + 1),
  ]) {
    await freshPage
      .locator("#project-import")
      .setInputFiles({ ...projectFile, buffer: Buffer.from(invalid) });
    await freshPage.getByRole("alert").waitFor();
    assert.deepEqual(
      await freshPage
        .locator(".object-row")
        .evaluateAll((items) =>
          items.map((item) => [item.dataset.objectId, item.getAttribute("aria-pressed")]),
        ),
      beforeImport,
    );
    assert.equal(
      await freshPage.getByRole("button", { name: "Undo", exact: true }).isEnabled(),
      true,
    );
  }
  assert.equal(confirmations, 0);
  await freshPage.locator("#project-import").setInputFiles(projectFile);
  await freshPage.waitForFunction(
    () => document.querySelector(".draft-feedback").textContent !== "Reading project file…",
  );
  assert.equal(confirmations, 1);
  assert.deepEqual(
    await freshPage
      .locator(".object-row")
      .evaluateAll((items) =>
        items.map((item) => [item.dataset.objectId, item.getAttribute("aria-pressed")]),
      ),
    beforeImport,
  );
  freshPage.removeAllListeners("dialog");
  freshPage.on("dialog", (dialog) => dialog.accept());
  await freshPage.locator("#project-import").setInputFiles(projectFile);
  await freshPage.getByText("Project imported", { exact: true }).waitFor();
  assert.equal(
    await freshPage.locator(".object-row").count(),
    expectedExport.scenes[0].objects.length,
  );
  assert.equal(
    await freshPage.getByRole("button", { name: "Undo", exact: true }).isDisabled(),
    true,
  );
  // Failed reads and edits made during a slow read must leave the live scene alone
  await freshPage.evaluate(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      File.prototype.text = read;
      return Promise.reject(new Error("Test file read failure"));
    };
  });
  await freshPage.locator("#project-import").setInputFiles(projectFile);
  await freshPage
    .getByRole("alert")
    .filter({ hasText: "Could not read the project file" })
    .waitFor();
  await freshPage.evaluate(() => {
    const read = File.prototype.text;
    File.prototype.text = function () {
      File.prototype.text = read;
      return new Promise((resolve) => {
        window.finishImportRead = resolve;
      });
    };
  });
  await freshPage.locator("#project-import").setInputFiles(projectFile);
  await freshPage.getByText("Reading project file…", { exact: true }).waitFor();
  await freshPage.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await freshPage.evaluate((text) => window.finishImportRead(text), exportedText);
  await freshPage
    .getByRole("alert")
    .filter({ hasText: "The scene changed while reading the file" })
    .waitFor();
  assert.equal(
    await freshPage.locator(".object-row").count(),
    expectedExport.scenes[0].objects.length + 1,
  );
  await freshPage.close();
  await page.evaluate(() => {
    URL.createObjectURL = () => {
      throw new Error("Test download failure");
    };
  });
  await page.locator(".draft-menu summary").click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Could not export the project" }).waitFor();
  assert.deepEqual(
    await rows.evaluateAll((items) => items.map((item) => item.dataset.objectId)),
    replacementIds,
  );

  console.log(
    "PASS: save/recover, export/import through file picker, moved transforms, rejected files, cancelled replacement and slow/failed reads",
  );
} finally {
  await browser.close();
}
