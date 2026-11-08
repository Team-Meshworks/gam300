import { launchBrowser, launchPersistentBrowser } from "./browser-security.mjs";
import { placeAtRoomCenter } from "./placement-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Wire writers omit empty extensions; compare authored values using the reader's defaults.
function withSceneDefaults(document) {
  return {
    ...document,
    scenes: document.scenes.map((scene) => ({ hotspots: [], interactions: [], ...scene })),
  };
}

const editorUrl = new URL("/editor.html", process.argv[2] ?? "http://127.0.0.1:5173/").href;
const browser = await launchBrowser({
  target: editorUrl,
  args: ["--enable-unsafe-swiftshader"],
});
let fileContext;
// Asset library is a pop up now. Only open it when closed, since the button toggles it
async function openLibrary(page) {
  if ((await page.locator(".asset-picker").count()) === 0) {
    await page.getByRole("button", { name: "Asset library", exact: true }).click();
  }
}

// Add arms placement; the viewport click commits the chosen asset
async function addAsset(page, name) {
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

  await openLibrary(page);
  await page.locator(".asset-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await placeAtRoomCenter(page);
}

try {
  const errors = [];
  // Fresh browser context keeps these writes away from the author's saved drafts
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(editorUrl);
  await page.waitForFunction(
    () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
  );
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  // An old browser backup must stay intact until the author explicitly converts it.
  const oldContext = await browser.newContext();
  try {
    const oldPage = await oldContext.newPage();
    oldPage.on("pageerror", (error) => errors.push(error.message));
    oldPage.on("dialog", (dialog) => dialog.accept());
    await oldPage.goto(editorUrl);
    await oldPage.waitForFunction(
      () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
    );
    const oldDocument = {
      ...fixture,
      scenes: fixture.scenes.map((scene) => {
        const older = { ...scene, environmentAssetId: null, viewpoints: [] };
        // This fixture predates the interaction extension; its reader rejects newer fields.
        delete older.hotspots;
        delete older.interactions;
        return older;
      }),
    };
    const original = {
      revision: 4,
      document: JSON.stringify(oldDocument),
      fileName: "old.json",
      savedJson: null,
      pristine: false,
    };
    await oldPage.evaluate(async (original) => {
      const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
      const db = await new IndexedDBDraftDatabase().getIndexedDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("session", "readwrite");
        tx.objectStore("session").put(original, "active");
        tx.oncomplete = resolve;
        tx.onabort = reject;
      });
      db.close();
    }, original);
    await oldPage.reload();
    await oldPage.getByText("Untitled project", { exact: true }).click();
    await oldPage.getByRole("button", { name: "Import older browser backup", exact: true }).click();
    await oldPage.getByRole("button", { name: "Convert and open", exact: true }).click();
    assert.match(await oldPage.getByRole("alert").innerText(), /environment/i);
    await oldPage.getByLabel("Environment for Room", { exact: false }).selectOption("test-room-v1");
    await oldPage.getByRole("button", { name: "Convert and open", exact: true }).click();
    await oldPage.getByText("old-converted.json", { exact: true }).waitFor();
    await oldPage.getByText("Not saved", { exact: true }).waitFor();
    const records = await oldPage.evaluate(async () => {
      const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
      const db = await new IndexedDBDraftDatabase().getIndexedDB();
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction("session", "readonly");
        const active = tx.objectStore("session").get("active");
        const original = tx.objectStore("session").get("older-scene-backup:4");
        tx.oncomplete = () => resolve({ active: active.result, original: original.result });
        tx.onabort = reject;
      });
      db.close();
      return records;
    });
    assert.deepEqual(records.original, original);
    const converted = JSON.parse(records.active.document);
    assert.equal(converted.schemaVersion, 2);
    assert.equal(converted.scenes[0].environmentAssetId, "test-room-v1");
    assert.equal(converted.scenes[0].objects.length, fixture.scenes[0].objects.length);
    assert.equal(records.active.savedJson, null, "Conversion needs an explicit save");
    await oldPage.reload();
    await oldPage.getByText("old-converted.json", { exact: true }).waitFor();
    await oldPage.getByText("Not saved", { exact: true }).waitFor();
    await oldPage.getByText("old-converted.json", { exact: true }).click();
    await oldPage
      .getByRole("button", { name: "Import older browser backup", exact: true })
      .waitFor();
    await oldPage.getByRole("button", { name: "Import older browser backup", exact: true }).click();
    await oldPage.getByRole("heading", { name: "Import older scene file" }).waitFor();
  } finally {
    await oldContext.close();
  }
  const contentFixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
  );
  const contentCases = JSON.parse(
    readFileSync(
      new URL("../shared/project/fixtures/project-format-cases.json", import.meta.url),
      "utf8",
    ),
  );
  // Isolate authored-content recovery from the legacy and file-permission cases below
  const formatContext = await browser.newContext();
  try {
    const formatPage = await formatContext.newPage();
    formatPage.on("pageerror", (error) => errors.push(error.message));
    await formatPage.goto(editorUrl);
    await formatPage.waitForFunction(
      () => document.querySelector(".draft-feedback")?.textContent !== "Reopening saved work…",
    );
    const preserved = await formatPage.evaluate(
      async ({ project, registry }) => {
        const { createDocumentStore } = await import("/document-store.ts");
        const { saveRecoverySession, loadRecoverySession } =
          await import("/persistence/local-drafts.ts");
        const kinds = new Map(Object.entries(registry));
        const store = createDocumentStore([]);
        const loaded = store.loadProject(JSON.stringify(project), kinds);
        if (!loaded.ok) throw new Error(loaded.error.message);
        const original = store.getSnapshot().project;
        const object = store.getSnapshot().objects[0];
        const moved = store.setTransform(object.id, { ...object.transform, position: [2, 1, -3] });
        if (!moved.ok) throw new Error(moved.error);
        const edited = store.getSnapshot().project;
        const encoded = JSON.stringify(edited);
        const saved = await saveRecoverySession(
          {
            document: edited,
            fileName: "content.json",
            savedJson: null,
            pristine: false,
            history: store.getRecoveryHistory(),
          },
          0,
          kinds,
        );
        if (!saved.ok) throw new Error(saved.error.message);
        const recovered = await loadRecoverySession(kinds);
        if (!recovered.ok || !recovered.value)
          throw new Error("Rich recovery session was not restored");
        // Rebuild the store from IndexedDB rather than retaining the original in-memory history
        const reopened = createDocumentStore([]);
        const restored = reopened.loadProject(
          JSON.stringify(recovered.value.document),
          kinds,
          recovered.value.history,
        );
        if (!restored.ok) throw new Error(restored.error.message);
        const same = JSON.stringify(reopened.getSnapshot().project) === encoded;
        reopened.undo();
        const undone = JSON.stringify(reopened.getSnapshot().project) === JSON.stringify(original);
        reopened.redo();
        return {
          same,
          undone,
          redone: JSON.stringify(reopened.getSnapshot().project) === JSON.stringify(edited),
          scenes: recovered.value.document.scenes.length,
        };
      },
      { project: contentFixture, registry: contentCases.assets },
    );
    assert.deepEqual(preserved, { same: true, undone: true, redone: true, scenes: 2 });
  } finally {
    await formatContext.close();
  }
  // Remove media dependencies; an unsupported content rule must still block preview
  const previewContext = await browser.newContext();
  try {
    const previewPage = await previewContext.newPage();
    previewPage.on("pageerror", (error) => errors.push(error.message));
    await previewPage.goto(editorUrl);
    await previewPage.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
    const modelOnly = structuredClone(contentFixture);
    for (const scene of modelOnly.scenes) {
      scene.rules = [];
      for (const object of scene.objects) object.components = [];
    }
    modelOnly.scenes[0].rules = [
      {
        id: "20000000-0000-4000-8000-000000000001",
        enabled: true,
        trigger: { type: "sceneStart" },
        actions: [
          {
            type: "moveCamera",
            viewpointId: modelOnly.scenes[0].viewpoints[0].id,
            durationSeconds: 1,
          },
        ],
      },
    ];
    await previewPage.locator("#project-import").setInputFiles({
      name: "two-scene.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(modelOnly)),
    });
    await previewPage.locator(".object-row").filter({ hasText: "First crate" }).waitFor();
    await previewPage.getByRole("button", { name: "Preview", exact: true }).click();
    await previewPage
      .getByRole("status")
      .filter({ hasText: "This preview does not support all the scenes and interactions" })
      .waitFor();
    assert.equal(await previewPage.locator(".editor-shell.is-previewing").count(), 0);
  } finally {
    await previewContext.close();
  }
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
  assert.equal(JSON.parse(results.stored.document).scenes[0].hotspots, undefined);
  assert.equal(JSON.parse(results.stored.document).scenes[0].interactions, undefined);
  assert.deepEqual(withSceneDefaults(JSON.parse(results.stored.document)), fixture);
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
  await legacyPage.goto(editorUrl);
  await legacyPage.waitForFunction(() => document.querySelector(".workspace")?.inert === false);
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
  const context = await launchPersistentBrowser({
    target: editorUrl,
    args: ["--enable-unsafe-swiftshader"],
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
  await editor.goto(editorUrl);
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
      (expected) => document.querySelector(".save-state .sr-only")?.textContent === expected,
      text,
    );
  const add = async () => {
    // New now follows first visit; choose the environment before adding the next test object
    if (await editor.getByText("Add a room to start.", { exact: true }).isVisible())
      await addAsset(editor, "Starter room");
    await addAsset(editor, "Sample crate");
  };
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
    editor
      .evaluate(
        async (name) =>
          JSON.parse(
            await (
              await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()
            ).text(),
          ),
        name,
      )
      .then(withSceneDefaults);
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
      if (
        count === null
          ? saved?.document === null
          : saved?.document?.scenes[0].objects.length === count
      )
        return saved;
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
  assert.equal(await editor.title(), "a.json - Spatia");
  assert.equal(await editor.locator(".project-file-name").count(), 0);
  await waitBackup(2);
  await editor.evaluate(() => {
    window.originalOpenPicker = window.showOpenFilePicker;
    window.showOpenFilePicker = async () => [
      {
        getFile: async () => new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversized.json"),
      },
    ];
  });
  await add();
  await status("Not saved");
  assert.equal(await editor.title(), "a.json - Spatia");
  await menu("Open");
  await editor
    .getByRole("alert")
    .filter({ hasText: "Project JSON exceeds the 5 MiB file limit" })
    .waitFor();
  await editor.evaluate(() => {
    window.showOpenFilePicker = window.originalOpenPicker;
  });
  assert.equal(
    await editor.title(),
    "a.json - Spatia",
    "Rejecting an oversized file keeps the current project",
  );
  // The pending edit still needs its recovery backup after the picker releases its reservation.
  const editedA = (await waitBackup(3)).document;
  assert.deepEqual(
    await readFile("a.json"),
    fixture,
    "Quiet recovery must not overwrite the JSON file",
  );
  assert.equal(await editor.locator(".save-state .sr-only").textContent(), "Not saved");
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  await status("Not saved");
  assert.equal(await editor.locator(".object-row").count(), 3);
  assert.deepEqual((await session()).document, editedA);
  assert.equal(await editor.title(), "a.json - Spatia");
  await editor.keyboard.press("Control+s");
  await status("Saved");
  assert.equal(await editor.title(), "a.json - Spatia");
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
  await waitBackup(null);
  await editor.getByText("Add a room to start.", { exact: true }).waitFor();
  assert.equal(await editor.locator("#project-save").isDisabled(), true);
  assert.equal((await readFile("a.json")).scenes[0].objects.length, 4, "Save completes before New");
  assert.equal(await editor.locator(".object-row").count(), 0);
  assert.equal(await editor.title(), "Untitled - Spatia");
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
  const empty = await waitBackup(null);
  assert.equal(empty.document, null);
  await editor.reload();
  await editor.getByText("Add a room to start.", { exact: true }).waitFor();
  assert.equal(await editor.locator(".object-row").count(), 0);
  assert.equal((await session()).document, null);

  await add();
  const beforeFailure = await waitBackup(1);
  assert.notEqual(beforeFailure.document.projectId, unsaved.document.projectId);
  assert.equal(beforeFailure.document.projectId[14], "7", "New projects use UUIDv7");
  assert.equal(beforeFailure.document.scenes[0].id[14], "4", "New scenes keep UUIDv4");
  await editor.reload();
  await editor.getByText("Reopened your last project", { exact: true }).waitFor();
  assert.equal((await session()).document.projectId, beforeFailure.document.projectId);
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
  await second.goto(editorUrl);
  await second.getByText("Reopened your last project", { exact: true }).waitFor();
  await add();
  await waitBackup(3);
  await addAsset(second, "Sample crate");
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
  assert.equal(await editor.title(), "a.json - Spatia");
  await add();
  await menu("New");
  await choose("Save");
  assert.equal(await editor.evaluate(() => window.pickerCount), pickerCount);
  assert.equal(await editor.title(), "Untitled - Spatia");
  // Verify the completed New decision without prescribing header layout or notification animation
  assert.equal((await session()).document, null);
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
  await fallback.goto(editorUrl);
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
  await addAsset(fallback, "Sample crate");
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
  await addAsset(fallback, "Sample crate");
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
    "PASS: richer document recovery and preview gating, manual Save/Save As, quiet recovery, restored dirty state, Save/Don’t Save/Cancel, failed switching, permissions, write conflicts, multi-tab protection and download fallback",
  );
} finally {
  await fileContext?.close();
  await browser.close();
}
