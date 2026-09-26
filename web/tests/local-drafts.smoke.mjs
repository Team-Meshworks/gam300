import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  // Fresh browser context keeps these writes away from the author's saved drafts
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await page.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
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
  // Native writable streams and cloneable handles come from isolated browser storage
  // Only the OS picker is substituted; no test touches a file in the author's folders
  const editor = await browser.newPage();
  editor.on("dialog", (dialog) => dialog.accept());
  await editor.addInitScript(() => {
    window.fileChoice = "source.json";
    window.saveChoice = "copy.json";
    window.pickerCount = 0;
    window.cancelPicker = false;
    window.showOpenFilePicker = async () => {
      if (window.cancelPicker) throw new DOMException("Cancelled", "AbortError");
      const directory = await navigator.storage.getDirectory();
      return [await directory.getFileHandle(window.fileChoice)];
    };
    window.showSaveFilePicker = async () => {
      window.pickerCount += 1;
      if (window.cancelPicker) throw new DOMException("Cancelled", "AbortError");
      const directory = await navigator.storage.getDirectory();
      return directory.getFileHandle(window.saveChoice, { create: true });
    };
  });
  await editor.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  const ready = editor.getByRole("status").filter({ hasText: "Scene ready" });
  await ready.waitFor();
  await editor.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  const menu = async (name) => {
    await editor.locator(".draft-menu summary").click();
    await editor.getByRole("button", { name, exact: true }).click();
  };
  const fileText = (name) =>
    editor.evaluate(async (fileName) => {
      const directory = await navigator.storage.getDirectory();
      return (await (await directory.getFileHandle(fileName)).getFile()).text();
    }, name);
  const writeFile = (name, text) =>
    editor.evaluate(
      async ({ name, text }) => {
        const directory = await navigator.storage.getDirectory();
        const handle = await directory.getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        await stream.write(text);
        await stream.close();
      },
      { name, text },
    );
  const waitSaved = () =>
    editor.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
  await writeFile("source.json", JSON.stringify(fixture));
  await menu("Open");
  await editor.getByText("Project opened", { exact: true }).waitFor();
  await waitSaved();
  const rows = editor.locator(".object-row");
  assert.equal(await rows.count(), 2);
  assert.equal(await editor.getByRole("button", { name: "Recover", exact: true }).count(), 0);
  await rows.first().click();
  await editor
    .getByRole("button", {
      name: `Move ${fixture.scenes[0].objects[0].name} X plus 0.25 metres`,
      exact: true,
    })
    .click();
  const expected = structuredClone(fixture);
  expected.scenes[0].objects[0].transform.position[0] += 0.25;
  await waitSaved();
  assert.deepEqual(
    JSON.parse(await fileText("source.json")),
    expected,
    "Autosave updates the opened file",
  );
  await menu("Save As");
  await editor.getByText("Saved copy.json", { exact: true }).waitFor();
  await waitSaved();
  assert.deepEqual(JSON.parse(await fileText("copy.json")), expected);
  await editor.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await waitSaved();
  assert.equal(JSON.parse(await fileText("copy.json")).scenes[0].objects.length, 3);
  assert.equal(
    JSON.parse(await fileText("source.json")).scenes[0].objects.length,
    2,
    "Save As leaves the old file alone",
  );
  await editor.keyboard.press("Control+s");
  await waitSaved();
  assert.equal(
    await editor.evaluate(() => window.pickerCount),
    1,
    "Save reuses the current destination",
  );
  await editor.evaluate(() => {
    window.cancelPicker = true;
  });
  await menu("Save As");
  await waitSaved();
  await editor.evaluate(() => {
    window.cancelPicker = false;
  });
  assert.equal(await editor.getByRole("alert").count(), 0, "Cancelling a picker is quiet");
  await editor.reload();
  await ready.waitFor();
  await editor
    .getByText("Project reopened; choose Save to reconnect its file", { exact: true })
    .waitFor();
  assert.equal(await editor.locator(".save-state").textContent(), "Saved in browser");
  await menu("Save");
  await waitSaved();
  assert.equal(await rows.count(), 3);
  await editor.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await waitSaved();
  assert.equal(
    JSON.parse(await fileText("copy.json")).scenes[0].objects.length,
    4,
    "Save reconnects the file after automatic recovery",
  );

  // Outside edits must survive a stale automatic write from this editor
  const external = JSON.parse(await fileText("copy.json"));
  external.title = "Outside edit";
  await writeFile("copy.json", JSON.stringify(external));
  await editor.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await editor.getByText("Save failed", { exact: true }).waitFor();
  assert.equal(JSON.parse(await fileText("copy.json")).title, "Outside edit");
  assert.equal(await rows.count(), 5);
  await editor.evaluate(() => {
    window.saveChoice = "rescued.json";
  });
  await menu("Save As");
  await editor.getByText("Saved rescued.json", { exact: true }).waitFor();
  await waitSaved();
  assert.equal(JSON.parse(await fileText("rescued.json")).scenes[0].objects.length, 5);

  // A failed file write keeps the scene and background recovery copy available
  await editor.evaluate(() => {
    window.realCreateWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async () => {
      throw new DOMException("Test write failure", "NotAllowedError");
    };
  });
  await editor.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await editor.getByText("Save failed", { exact: true }).waitFor();
  assert.equal(await rows.count(), 6);
  assert.equal(JSON.parse(await fileText("rescued.json")).scenes[0].objects.length, 5);
  await editor.evaluate(() => {
    FileSystemFileHandle.prototype.createWritable = window.realCreateWritable;
  });
  // The replacement dialog belongs to the editor; Cancel keeps unsaved file changes
  await menu("Open");
  await editor.getByRole("dialog").waitFor();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await rows.count(), 6);
  await menu("Save");
  await waitSaved();
  assert.equal(JSON.parse(await fileText("rescued.json")).scenes[0].objects.length, 6);
  await writeFile("bad.json", "{broken");
  await editor.evaluate(() => {
    window.fileChoice = "bad.json";
  });
  await menu("Open");
  await editor.getByRole("alert").filter({ hasText: "Project JSON is malformed" }).waitFor();
  assert.equal(await rows.count(), 6);

  // Save on a project with no destination follows the Save As path
  await editor.getByRole("button", { name: "Open sample project", exact: true }).click();
  await editor.getByRole("dialog").waitFor();
  await editor.getByRole("button", { name: "Replace", exact: true }).click();
  await editor.getByText("Opened sample project", { exact: true }).waitFor();
  await editor.evaluate(() => {
    window.saveChoice = "new-project.json";
  });
  const pickerCount = await editor.evaluate(() => window.pickerCount);
  await menu("Save");
  // Saving feedback can be replaced by the queued browser backup; check the durable result
  await waitSaved();
  assert.equal(await editor.evaluate(() => window.pickerCount), pickerCount + 1);
  assert.equal(JSON.parse(await fileText("new-project.json")).scenes[0].objects.length, 2);

  // Start from the asset library with no sample or imported project
  const fresh = await browser.newPage();
  fresh.on("dialog", (dialog) => dialog.accept());
  const leavingWouldWarn = () =>
    fresh.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  await fresh.addInitScript(() => {
    window.showSaveFilePicker = async () =>
      (await navigator.storage.getDirectory()).getFileHandle("fresh.json", { create: true });
  });
  await fresh.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await fresh.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await fresh.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  await fresh.getByRole("button", { name: "Add test-room", exact: true }).click();
  await fresh.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "Saved in browser",
  );
  await fresh.locator(".draft-menu summary").click();
  await fresh.getByRole("button", { name: "Save", exact: true }).click();
  await fresh.getByText("Saved fresh.json", { exact: true }).waitFor();
  const freshDocument = await fresh.evaluate(async () =>
    JSON.parse(
      await (
        await (await (await navigator.storage.getDirectory()).getFileHandle("fresh.json")).getFile()
      ).text(),
    ),
  );
  assert.equal(freshDocument.scenes[0].environmentAssetId, "test-room-v1");
  assert.equal(freshDocument.scenes[0].objects.length, 0);
  await fresh.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await fresh.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
  const readFreshFile = () =>
    fresh.evaluate(async () =>
      JSON.parse(
        await (
          await (
            await (await navigator.storage.getDirectory()).getFileHandle("fresh.json")
          ).getFile()
        ).text(),
      ),
    );
  const written = await readFreshFile();
  assert.equal(written.scenes[0].objects.length, 1);
  const placed = written.scenes[0].objects[0];
  await fresh
    .getByRole("button", { name: `Move ${placed.name} X plus 0.25 metres`, exact: true })
    .click();
  await fresh.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
  const moved = structuredClone(written);
  moved.scenes[0].objects[0].transform.position[0] += 0.25;
  assert.deepEqual(await readFreshFile(), moved, "Movement reaches the same saved document");
  await fresh.getByRole("button", { name: "Undo", exact: true }).click();
  await fresh.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
  assert.deepEqual(await readFreshFile(), written, "Undo restores the whole saved transform");
  await fresh.locator(".draft-menu summary").click();
  await fresh.getByRole("button", { name: "Save", exact: true }).click();
  await fresh.waitForFunction(() => document.querySelector(".save-state")?.textContent === "Saved");
  assert.equal(await leavingWouldWarn(), false, "File is up to date");
  await fresh.reload();
  await fresh
    .getByText("Project reopened; choose Save to reconnect its file", { exact: true })
    .waitFor();
  await fresh.waitForFunction(
    () => document.querySelectorAll(".object-row").length === 1,
    undefined,
    { timeout: 3000 },
  );
  assert.equal(await fresh.locator(".object-row").getAttribute("data-object-id"), placed.id);
  // Read the revalidated recovery copy after JavaScript memory has been discarded
  const recovered = await fresh.evaluate(async (projectId) => {
    const { loadLocalDraft } = await import("/persistence/local-drafts.ts");
    return loadLocalDraft(
      projectId,
      new Map([
        ["test-room-v1", "environment"],
        ["test-crate-v1", "model"],
      ]),
    );
  }, written.projectId);
  assert.equal(recovered.ok, true);
  assert.deepEqual(
    recovered.value.document,
    written,
    "Place–move–undo–save–reload preserves the document",
  );
  assert.deepEqual(await readFreshFile(), written, "Reload preserves the portable file too");
  await fresh.close();

  // Browsers without file pickers retain JSON opening and download fallback
  const fallback = await browser.newPage();
  await fallback.addInitScript(() => {
    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
  });
  await fallback.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await fallback.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await fallback.locator(".draft-menu summary").click();
  const choosing = fallback.waitForEvent("filechooser");
  await fallback.getByRole("button", { name: "Open", exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(written)),
  });
  await fallback.getByText("Project opened", { exact: true }).waitFor();
  await fallback.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "Saved",
  );
  await fallback.locator(".draft-menu summary").click();
  const downloading = fallback.waitForEvent("download");
  await fallback.getByRole("button", { name: "Save As", exact: true }).click();
  assert.deepEqual(JSON.parse(readFileSync(await (await downloading).path(), "utf8")), written);
  await fallback.close();
  await editor.close();
  console.log(
    "PASS: place–move–undo–save–reload, storage guards, file Open/Save/Save As, autosave, file reconnection, cancellation, external conflicts, write failures and download fallback",
  );
} finally {
  await browser.close();
}
