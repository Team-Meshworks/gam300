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
let fileContext;
try {
  const errors = [];
  // Fresh browser context keeps these writes away from the author's saved drafts
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
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
        const open = indexedDB.open("vthere-local-drafts", 2);
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
        const open = indexedDB.open("vthere-local-drafts", 2);
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

  await page.close();
  // One corrupt legacy draft must not hide another readable project during migration
  const legacyPage = await browser.newPage();
  legacyPage.on("pageerror", (error) => errors.push(error.message));
  const recoveryQuestions = [];
  legacyPage.on("dialog", async (dialog) => {
    recoveryQuestions.push(dialog.message());
    await dialog.accept();
  });
  await legacyPage.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  await legacyPage.waitForFunction(() => !document.querySelector(".workspace").inert);
  const legacyResult = await legacyPage.evaluate(async (fixture) => {
    const { saveLocalDraft, loadLatestLocalDraft } = await import("/persistence/local-drafts.ts");
    const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
    const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
    const older = { ...fixture, projectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
    for (const project of [older, fixture]) {
      const saved = await saveLocalDraft(
        { project, expectedStorageRevision: 0, localEditSequence: 1 },
        kinds,
      );
      if (!saved.ok) throw new Error(saved.error.message);
    }
    await new Promise((resolve, reject) => {
      const open = indexedDB.open("vthere-local-drafts", 2);
      open.onsuccess = () => {
        const database = open.result;
        const tx = database.transaction("drafts", "readwrite");
        const drafts = tx.objectStore("drafts");
        const read = drafts.get(["local", older.projectId]);
        read.onsuccess = () => drafts.put({ ...read.result, savedAt: "damaged timestamp" });
        tx.oncomplete = () => {
          database.close();
          resolve();
        };
        tx.onabort = () => {
          database.close();
          reject(tx.error);
        };
      };
    });
    return loadLatestLocalDraft(kinds);
  }, fixture);
  assert.equal(legacyResult.ok, true);
  assert.equal(legacyResult.value.document.projectId, fixture.projectId);
  assert.ok(legacyResult.value.recoveryWarning);
  await legacyPage.reload();
  await legacyPage.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.equal(await legacyPage.locator(".object-row").count(), 2);
  assert.equal(recoveryQuestions.length, 1, "Recovering past a damaged record needs one decision");
  const damagedKept = await legacyPage.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("vthere-local-drafts", 2);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("drafts", "readonly");
          const read = tx
            .objectStore("drafts")
            .get(["local", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);
          tx.oncomplete = () => {
            db.close();
            resolve(read.result?.savedAt === "damaged timestamp");
          };
        };
      }),
  );
  assert.equal(damagedKept, true);
  await legacyPage.close();
  // Real file streams live in an isolated browser folder; only the OS pickers are substituted
  // A temporary regular profile exercises durable handles across reloads
  // Chromium's headless incognito profile crashes when cloning OPFS handles into IndexedDB
  const context = await chromium.launchPersistentContext("", {
    args: ["--enable-unsafe-swiftshader"],
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  fileContext = context;
  const editor = await context.newPage();
  editor.on("pageerror", (error) => errors.push(error.message));
  editor.on("dialog", (dialog) => dialog.accept());
  await context.addInitScript(() => {
    window.fileChoice = "a.json";
    window.saveChoice = "a.json";
    window.cancelPicker = false;
    window.denyPermission = false;
    window.failWrite = false;
    window.failRecovery = false;
    window.permissionRequests = 0;
    window.pickerCount = 0;
    const queryPermission = FileSystemFileHandle.prototype.queryPermission;
    FileSystemFileHandle.prototype.queryPermission = function (options) {
      return window.denyPermission
        ? Promise.resolve("prompt")
        : queryPermission.call(this, options);
    };
    const permission = FileSystemFileHandle.prototype.requestPermission;
    FileSystemFileHandle.prototype.requestPermission = function (options) {
      window.permissionRequests += 1;
      return window.denyPermission ? Promise.resolve("denied") : permission.call(this, options);
    };
    const writable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (window.failWrite) throw new DOMException("Write failed", "NotAllowedError");
      return writable.apply(this, args);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const result = put.apply(this, args);
      if (window.failRecovery && this.name === "session") this.transaction.abort();
      return result;
    };
    window.showOpenFilePicker = async () => {
      if (window.cancelPicker) throw new DOMException("Cancelled", "AbortError");
      return [await (await navigator.storage.getDirectory()).getFileHandle(window.fileChoice)];
    };
    window.showSaveFilePicker = async () => {
      window.pickerCount += 1;
      if (window.cancelPicker) throw new DOMException("Cancelled", "AbortError");
      return (await navigator.storage.getDirectory()).getFileHandle(window.saveChoice, {
        create: true,
      });
    };
  });
  const url = process.argv[2] ?? "http://127.0.0.1:5173/";
  await editor.goto(url);
  await editor.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await editor.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  const menu = async (name) => {
    await editor.locator(".draft-menu summary").click();
    await editor.getByRole("button", { name, exact: true }).click();
  };
  const choose = async (name) => {
    await editor.getByRole("dialog").getByRole("button", { name, exact: true }).click();
    await editor.getByRole("dialog").waitFor({ state: "detached" });
    await editor.waitForFunction(
      () => !document.querySelector(".draft-menu-panel button").disabled,
    );
  };
  const status = (text, target = editor) =>
    target.waitForFunction(
      (expected) => document.querySelector(".save-state")?.textContent === expected,
      text,
    );
  const add = () => editor.getByRole("button", { name: "Add test-crate", exact: true }).click();
  const writeFile = (name, text) =>
    editor.evaluate(
      async ({ name, text }) => {
        const handle = await (
          await navigator.storage.getDirectory()
        ).getFileHandle(name, { create: true });
        const stream = await handle.createWritable();
        await stream.write(text);
        await stream.close();
      },
      { name, text },
    );
  const readFile = (name) =>
    editor.evaluate(
      async (name) =>
        JSON.parse(
          await (
            await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()
          ).text(),
        ),
      name,
    );
  const session = (target = editor) =>
    target.evaluate(async () => {
      const { loadRecoverySession } = await import("/persistence/local-drafts.ts");
      const result = await loadRecoverySession(
        new Map([
          ["test-room-v1", "environment"],
          ["test-crate-v1", "model"],
          ["sample-snowglobe-v1", "model"],
        ]),
      );
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  async function waitBackup(count, target = editor) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const saved = await session(target);
      if (saved?.document.scenes[0].objects.length === count) return saved;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Recovery did not reach ${count} objects`);
  }
  const other = structuredClone(fixture);
  other.projectId = "11111111-1111-4111-8111-111111111111";
  other.title = "Other project";
  await writeFile("a.json", JSON.stringify(fixture, null, 2));
  await writeFile("b.json", JSON.stringify(other));
  await menu("Open");
  await status("Saved");
  assert.equal(
    await editor.evaluate(() => window.permissionRequests),
    0,
    "Open does not ask to write the chosen file",
  );
  assert.equal(await editor.title(), "a.json - VThere");
  assert.equal(await editor.locator(".project-file-name").count(), 0);
  await add();
  await status("Not saved");
  assert.equal(await editor.title(), "a.json - VThere");
  const editedA = (await waitBackup(3)).document;
  assert.deepEqual(
    await readFile("a.json"),
    fixture,
    "Quiet recovery must not overwrite the JSON file",
  );
  assert.equal(await editor.locator(".save-state").textContent(), "Not saved");
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  await status("Not saved");
  assert.equal(await editor.locator(".object-row").count(), 3);
  assert.deepEqual((await session()).document, editedA);
  assert.equal(await editor.title(), "a.json - VThere");
  await editor.keyboard.press("Control+s");
  await status("Saved");
  assert.equal(await editor.title(), "a.json - VThere");
  assert.deepEqual(await readFile("a.json"), editedA);
  assert.equal(
    await editor.evaluate(() => window.pickerCount),
    0,
    "Save after reload keeps its file",
  );
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  await status("Saved");

  // Opening a saved scene requires no decision; dirty scenes offer all three choices
  await editor.evaluate(() => (window.fileChoice = "b.json"));
  await menu("Open");
  await status("Saved");
  assert.equal(await editor.getByRole("dialog").count(), 0);
  await add();
  await waitBackup(3);
  await editor.evaluate(() => (window.fileChoice = "a.json"));
  await menu("Open");
  await choose("Cancel");
  assert.equal((await session()).document.projectId, other.projectId);
  assert.equal(await editor.locator(".object-row").count(), 3);
  await menu("Open");
  await choose("Don’t Save");
  await status("Saved");
  assert.deepEqual((await session()).document, editedA);
  assert.deepEqual(
    await readFile("b.json"),
    other,
    "Discard leaves the last manual file untouched",
  );
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.deepEqual((await session()).document, editedA, "Discarded B must not return on reload");

  await add();
  await waitBackup(4);
  await menu("New");
  await choose("Save");
  await status("Not saved");
  assert.equal((await readFile("a.json")).scenes[0].objects.length, 4, "Save completes before New");
  assert.equal(await editor.locator(".object-row").count(), 0);
  assert.equal(await editor.title(), "Untitled - VThere");
  await menu("New");
  assert.equal(
    await editor.getByRole("dialog").count(),
    0,
    "Empty untouched scene needs no decision",
  );
  await add();
  const unsaved = await waitBackup(1);
  await editor.evaluate(() => (window.cancelPicker = true));
  await menu("New");
  await choose("Save");
  assert.equal(
    (await session()).document.projectId,
    unsaved.document.projectId,
    "Cancelled Save keeps the active project",
  );
  assert.equal(await editor.locator(".object-row").count(), 1);
  await editor.evaluate(() => (window.cancelPicker = false));
  await menu("New");
  await choose("Don’t Save");
  const empty = await waitBackup(0);
  assert.notEqual(empty.document.projectId, unsaved.document.projectId);
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.equal(await editor.locator(".object-row").count(), 0);

  await add();
  const beforeFailure = await waitBackup(1);
  await editor.evaluate(() => (window.failRecovery = true));
  await menu("New");
  await choose("Don’t Save");
  await editor.getByRole("alert").filter({ hasText: "Recovery backup failed" }).waitFor();
  assert.deepEqual(
    await session(),
    beforeFailure,
    "Failed switch preserves the previous recovery record",
  );
  assert.equal(await editor.locator(".object-row").count(), 1);
  await editor.evaluate(() => {
    window.failRecovery = false;
    window.saveChoice = "saved.json";
    window.denyPermission = true;
  });
  await menu("Save");
  await status("Save failed");
  assert.equal(await editor.locator(".object-row").count(), 1);
  await editor.evaluate(() => {
    window.denyPermission = false;
    window.failWrite = true;
  });
  await menu("Save");
  await status("Save failed");
  assert.equal(await editor.locator(".object-row").count(), 1);
  await editor.evaluate(() => (window.failWrite = false));
  await menu("Save");
  await status("Saved");
  const saved = await readFile("saved.json");
  await add();
  await waitBackup(2);
  assert.deepEqual(await readFile("saved.json"), saved);
  const external = { ...saved, title: "Changed elsewhere" };
  await writeFile("saved.json", JSON.stringify(external));
  await menu("Save");
  await status("Save failed");
  assert.deepEqual(await readFile("saved.json"), external, "Save refuses a stale overwrite");
  await editor.evaluate(() => (window.saveChoice = "copy.json"));
  await editor.keyboard.press("Control+Shift+s");
  await status("Saved");
  assert.equal((await readFile("copy.json")).scenes[0].objects.length, 2);
  assert.deepEqual(await readFile("saved.json"), external);
  await writeFile("bad.json", "{");
  await editor.evaluate(() => (window.fileChoice = "bad.json"));
  await menu("Open");
  await editor.getByRole("alert").waitFor();
  assert.equal(await editor.locator(".object-row").count(), 2);
  assert.equal(
    await editor.getByRole("dialog").count(),
    0,
    "Validate before asking to discard work",
  );

  // Another tab cannot replace the active recovery session from a stale revision
  const second = await context.newPage();
  second.on("dialog", (dialog) => dialog.accept());
  await second.goto(url);
  await second.getByText("Reopened your last project", { exact: true }).waitFor();
  await add();
  await waitBackup(3);
  await second.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await second.getByRole("alert").filter({ hasText: "Recovery changed in another tab" }).waitFor();
  assert.equal(await second.locator(".object-row").count(), 3);
  await second.close();

  // Opening an existing file keeps its destination through both Save routes
  // A second picker here would turn an ordinary Save into Save As
  await editor.evaluate(() => (window.fileChoice = "b.json"));
  await menu("Open");
  await choose("Don’t Save");
  await status("Saved");
  const pickerCount = await editor.evaluate(() => window.pickerCount);
  await add();
  await waitBackup(3);
  await menu("Save");
  await status("Saved");
  assert.equal(await editor.evaluate(() => window.pickerCount), pickerCount);
  assert.equal((await readFile("b.json")).scenes[0].objects.length, 3);
  await add();
  await waitBackup(4);
  await editor.evaluate(() => (window.fileChoice = "a.json"));
  await menu("Open");
  assert.equal(
    await editor.getByRole("dialog").locator("p").textContent(),
    "Your changes will be lost if you don’t save",
  );
  await choose("Save");
  await status("Saved");
  assert.equal(await editor.evaluate(() => window.pickerCount), pickerCount);
  assert.equal((await readFile("b.json")).scenes[0].objects.length, 4);
  assert.equal(await editor.title(), "a.json - VThere");
  await add();
  await menu("New");
  await choose("Save");
  assert.equal(await editor.evaluate(() => window.pickerCount), pickerCount);
  assert.equal(await editor.title(), "Untitled - VThere");
  const layout = await editor.evaluate(() => {
    const actions = [
      ...document.querySelectorAll(".history-controls button"),
      document.querySelector(".mode-actions button"),
      document.querySelector(".project-file-status"),
    ].map((element) => element.getBoundingClientRect());
    const meter = document.querySelector(".fps-meter").getBoundingClientRect();
    return {
      gaps: actions.slice(1).map((rect, index) => rect.left - actions[index].right),
      meterBelowHeader:
        meter.top >= document.querySelector(".app-header").getBoundingClientRect().bottom,
    };
  });
  assert.deepEqual(layout.gaps, [24, 24, 24, 24, 24]);
  assert.equal(layout.meterBelowHeader, true);
  assert.equal(await editor.locator(".draft-feedback").textContent(), "New project");
  await editor.waitForFunction(() => {
    const opacity = Number(getComputedStyle(document.querySelector(".draft-feedback")).opacity);
    return opacity > 0 && opacity < 1;
  });
  await editor.waitForFunction(() => document.querySelector(".draft-feedback").textContent === "");
  await context.close();

  // Download fallback never claims the browser confirmed a completed disk save
  const fallback = await browser.newPage();
  fallback.on("pageerror", (error) => errors.push(error.message));
  fallback.on("dialog", (dialog) => dialog.accept());
  await fallback.addInitScript(() => {
    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
    window.failRecovery = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failRecovery && this.name === "session")
        throw new DOMException("Storage full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await fallback.goto(url);
  await fallback.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  await fallback.locator(".draft-menu summary").click();
  const choosing = fallback.waitForEvent("filechooser");
  await fallback.getByRole("button", { name: "Open", exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: "project.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await fallback.getByText("Project opened", { exact: true }).waitFor();
  await fallback.evaluate(() => {
    window.failRecovery = true;
  });
  await fallback.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await fallback.getByRole("alert").filter({ hasText: "Recovery backup failed" }).waitFor();
  await fallback.evaluate(() => {
    window.failRecovery = false;
  });
  await fallback.locator(".draft-menu summary").click();
  const downloading = fallback.waitForEvent("download");
  await fallback.getByRole("button", { name: "Save As", exact: true }).click();
  const downloaded = JSON.parse(readFileSync(await (await downloading).path(), "utf8"));
  assert.equal(downloaded.scenes[0].objects.length, 3);
  // The download can finish before the recovery write and its UI update
  await status("Not saved", fallback);
  await waitBackup(3, fallback);
  await fallback.getByRole("button", { name: "Add test-crate", exact: true }).click();
  await waitBackup(4, fallback);
  await fallback.reload();
  await fallback.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.equal(
    await fallback.locator(".object-row").count(),
    4,
    "Save restarts later browser backups",
  );
  assert.deepEqual(errors, [], "Storage failures are handled without uncaught errors");
  await fallback.close();
  console.log(
    "PASS: manual Save/Save As, quiet recovery, restored dirty state, Save/Don’t Save/Cancel, failed switching, permissions, write conflicts, multi-tab protection and download fallback",
  );
} finally {
  await fileContext?.close();
  await browser.close();
}
