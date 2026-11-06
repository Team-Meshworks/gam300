import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const browser = await launchBrowser({ target: base, args: ["--enable-unsafe-swiftshader"] });
const context = await browser.newContext();
let account = alice,
  document = structuredClone(fixture),
  revision = 7,
  mode = "saved";
let releaseSave;
let catalogueUnavailable = true;
const writes = [],
  errors = [];
const api = async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  const json = (status, body) => route.fulfill({ status, json: body });
  if (path === "/api/v1/auth/session")
    return account
      ? json(200, {
          userId: account,
          displayName: "Student",
          role: "Creator",
          orgId: bob,
          mustChangePassword: false,
        })
      : json(401, {});
  if (request.headers()["x-spatia-account"] && request.headers()["x-spatia-account"] !== account)
    return json(403, {});
  if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
  if (path === "/api/v1/assets") return catalogueUnavailable ? json(503, {}) : json(200, []);
  if (path === `/api/v1/projects/${fixture.projectId}/assets`) return json(200, []);
  if (path === "/api/v1/auth/logout") {
    account = null;
    return route.fulfill({ status: 204 });
  }
  if (path === `/api/v1/projects/${fixture.projectId}`) {
    if (request.method() === "GET")
      return json(200, {
        projectId: fixture.projectId,
        revision,
        document,
        permissions: { canEdit: true },
      });
    const body = request.postDataJSON();
    writes.push(body);
    if (mode === "delayed")
      await new Promise((resolve) => {
        releaseSave = resolve;
      });
    if (mode === "failed") return json(503, {});
    if (mode === "conflict" || body.expectedRevision !== revision) return json(409, {});
    assert.equal(request.headers()["x-csrf-token"], "test-token");
    document = body.document;
    revision++;
    return json(200, {
      projectId: fixture.projectId,
      clientMutationId: body.clientMutationId,
      revision,
    });
  }
  return json(404, {});
};
await context.route("**/api/**", api);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
const url = `${base}/?projectId=${fixture.projectId}`;
const status = page.locator('.server-session [role="status"]');
async function ready() {
  await page.getByRole("button", { name: "Scenes", exact: true }).click();
  await page.getByLabel("Scene name", { exact: true }).waitFor();
}
async function edit(name) {
  await page.getByLabel("Scene name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Rename scene", exact: true }).click();
}
async function saved() {
  await page.waitForFunction(
    () =>
      document.querySelector('.server-session [role="status"]')?.textContent === "Saved to server",
  );
}
try {
  await page.goto(url);
  await page.getByRole("button", { name: "Retry opening" }).waitFor();
  assert.equal(await page.locator(".editor-shell").count(), 0);
  catalogueUnavailable = false;
  await page.getByRole("button", { name: "Retry opening" }).click();
  await saved();
  await page.getByRole("button", { name: "Leave editor" }).focus();
  await page.keyboard.press("Enter");
  const departureSave = page.getByRole("button", { name: "Save and continue" });
  await departureSave.waitFor();
  assert.equal(await departureSave.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.waitForURL(`${base}/home`, { timeout: 5000 });
  await page.goto(url);
  await saved();
  await ready();
  await page.screenshot({ path: ".artifacts/scrum67-editor.png" });
  await edit("Autosaved in the real editor");
  await saved();
  assert.equal(document.scenes[0].name, "Autosaved in the real editor");
  assert.equal(writes.length, 1);
  // Publishing goes through the same preservation choices as leaving the editor.
  mode = "failed";
  await edit("Draft before publishing");
  await status.filter({ hasText: "Save failed" }).waitFor();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Draft before publishing",
  );
  assert.notEqual(document.scenes[0].name, "Draft before publishing");
  mode = "saved";
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await page.waitForURL(`${base}/publish?projectId=${fixture.projectId}`);
  assert.equal(document.scenes[0].name, "Draft before publishing");
  await page.goto(url);
  await saved();
  await ready();
  // A fresh browser opens the confirmed server content without local recovery.
  const freshContext = await browser.newContext();
  await freshContext.route("**/api/**", api);
  const fresh = await freshContext.newPage();
  await fresh.goto(url);
  await fresh.getByRole("button", { name: "Scenes", exact: true }).click();
  assert.equal(
    await fresh.getByLabel("Scene name", { exact: true }).inputValue(),
    document.scenes[0].name,
  );
  await freshContext.close();
  mode = "failed";
  await edit("Offline edit");
  await status.filter({ hasText: "Save failed" }).waitFor();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  assert.equal(new URL(page.url()).searchParams.get("projectId"), fixture.projectId);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const failedMutation = writes.at(-1).clientMutationId;
  mode = "saved";
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await saved();
  assert.equal(writes.at(-1).clientMutationId, failedMutation);
  assert.equal(document.scenes[0].name, "Offline edit");
  mode = "conflict";
  await edit("Conflicting local edit");
  await status.filter({ hasText: "Another revision" }).waitFor();
  const attempts = writes.length;
  // Native export cancellation must not permit logout.
  await page.evaluate(() => {
    window.showSaveFilePicker = async () => {
      throw new DOMException("Cancelled", "AbortError");
    };
  });
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Export and continue", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Open server version", exact: true }).click();
  await page.getByRole("button", { name: "Keep recovery and continue", exact: true }).click();
  await page.getByRole("dialog", { name: "A recovery copy is available" }).waitFor();
  assert.equal(writes.length, attempts);
  await page.getByRole("button", { name: "Recover my edits", exact: true }).click();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Conflicting local edit",
  );
  await status.filter({ hasText: "Another revision" }).waitFor();
  await page.getByRole("button", { name: "Open server version", exact: true }).click();
  await page.getByRole("button", { name: "Keep recovery and continue", exact: true }).click();
  mode = "saved";
  await page
    .getByRole("button", { name: "Use server version and discard recovery", exact: true })
    .click();
  await saved();
  await ready();
  assert.equal(await page.getByLabel("Scene name", { exact: true }).inputValue(), "Offline edit");
  // An acknowledgement for an older edit must not mark newer work saved.
  mode = "delayed";
  await edit("First edit while saving");
  await status.filter({ hasText: "Saving to server" }).waitFor();
  while (!releaseSave) await new Promise((resolve) => setTimeout(resolve, 10));
  await edit("Newer edit while saving");
  assert.notEqual(await status.textContent(), "Saved to server");
  mode = "saved";
  releaseSave();
  await saved();
  assert.equal(document.scenes[0].name, "Newer edit while saving");

  // Expiry redirects only after preserving unsynced edits for the original account.
  mode = "failed";
  await edit("Draft retained after sign-out");
  await status.filter({ hasText: "Save failed" }).waitFor();
  account = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(`${base}/login`);
  await page.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
  account = alice;
  mode = "saved";
  await page.goto(url);
  await page.getByRole("button", { name: "Recover my edits", exact: true }).click();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Draft retained after sign-out",
  );
  await saved();
  assert.equal(document.scenes[0].name, "Draft retained after sign-out");

  // A failed local checkpoint blocks both saving and recovery-based departure.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.failRecovery = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failRecovery && this.name === "session")
        throw new DOMException("Full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  const beforeStorageFailure = writes.length;
  await edit("Storage failure edit");
  await status.filter({ hasText: "Save failed" }).waitFor();
  assert.equal(writes.length, beforeStorageFailure);
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Keep recovery and continue", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => {
    window.failRecovery = false;
  });
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await saved();
  assert.equal(document.scenes[0].name, "Storage failure edit");

  // Expiry plus a failed final backup must retain the only live draft behind its owner.
  await page.evaluate(() => {
    window.failRecovery = true;
  });
  await edit("Only live draft after expiry");
  await status.filter({ hasText: "Save failed" }).waitFor();
  account = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("alert").filter({ hasText: "recovery storage failed" }).waitFor();
  assert.equal(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
  );

  assert.equal(await page.locator(".editor-shell").count(), 0);
  await page.getByRole("button", { name: "Retry opening" }).click();
  await page.getByRole("alert").filter({ hasText: "Sign in before opening" }).waitFor();
  assert.equal(page.url(), url, "A failed recovery write must keep the only draft in this tab");
  assert.equal(await page.locator(".editor-shell").count(), 0);
  account = alice;
  await page.evaluate(() => {
    window.failRecovery = false;
  });
  await page.getByRole("button", { name: "Retry opening" }).click();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Only live draft after expiry",
  );
  await saved();
  assert.equal(document.scenes[0].name, "Only live draft after expiry");

  // Download fallback produces the current portable file, without treating it as a receipt.
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export a copy", exact: true }).click(),
  ]);
  assert.equal(
    JSON.parse(readFileSync(await download.path(), "utf8")).scenes[0].name,
    "Only live draft after expiry",
  );
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export and continue", exact: true }).click(),
  ]);
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Changing cookies must hide the old editor and keep recovery in its original account.
  mode = "failed";
  await edit("Alice private edit");
  await status.filter({ hasText: "Save failed" }).waitFor();
  account = bob;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("alert").filter({ hasText: "account changed or expired" }).waitFor();
  assert.equal(await page.locator(".editor-shell").count(), 0);
  await page.reload();
  await saved();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Only live draft after expiry",
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  const departureName = await page.getByLabel("Scene name", { exact: true }).elementHandle();
  // Hold the final backup completion after preservation, while App is still mounted.
  mode = "saved";
  await edit("Preserved departure edit");
  await saved();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "session" && ++writes === 2) {
        const transaction = this.transaction;
        const complete = transaction.oncomplete;
        transaction.oncomplete = (event) => {
          window.releaseDeparture = () => complete.call(transaction, event);
        };
      }
      return put.apply(this, args);
    };
  });
  // A confirmed recovery choice permits logout, but never deletes another account's work.
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await page.getByRole("button", { name: "Keep recovery and continue", exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseDeparture === "function");
  await page.keyboard.press("Control+z");
  assert.equal(await departureName.evaluate((input) => input.value), "Preserved departure edit");
  await page.evaluate(() => window.releaseDeparture());
  await page.waitForURL("**/login");
  assert.equal(account, null);
  assert.deepEqual(errors, []);
  console.log(
    "Actual editor autosave, fresh open, retry identity, conflict/recovery choices, cancelled export/logout, delayed acknowledgements, expiry redirects with draft recovery, storage failure, successful logout and account isolation passed.",
  );
} finally {
  await browser.close();
}
