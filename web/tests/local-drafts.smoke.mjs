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
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5173/");
  const fixture = JSON.parse(
    readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
  );
  const results = await page.evaluate(async (project) => {
    const { saveLocalDraft } = await import("/persistence/local-drafts.ts");
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

    const first = await saveLocalDraft(request, assets);
    const stored = await readStored();
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
    try {
      IDBFactory.prototype.open = () => {
        throw new DOMException("Storage disabled", "SecurityError");
      };
      unavailable = await saveLocalDraft(request, assets);
    } finally {
      IDBFactory.prototype.open = originalOpen;
    }
    return {
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
  console.log(
    "PASS: IndexedDB save, validation, competing writes, stale edits, abort and unavailable storage",
  );
} finally {
  await browser.close();
}
