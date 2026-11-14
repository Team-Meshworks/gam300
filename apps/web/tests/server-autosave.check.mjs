import { launchBrowser } from "./browser-security.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:5173").origin;
const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m1-project.json", import.meta.url), "utf8"),
);
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const browser = await launchBrowser({ target: base, args: ["--enable-unsafe-swiftshader"] });
const context = await browser.newContext();
await context.addInitScript(() => {
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
});
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
          developmentAssetsAllowed: true,
        })
      : json(401, {});
  if (request.headers()["x-spatia-account"] && request.headers()["x-spatia-account"] !== account)
    return json(403, {});
  if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
  if (path === "/api/v1/assets") return catalogueUnavailable ? json(503, {}) : json(200, []);
  if (path === `/api/v1/projects/${fixture.projectId}/assets`) return json(200, []);
  if (path === `/api/v1/projects/${fixture.projectId}/publication-readiness`)
    return json(200, {
      projectId: fixture.projectId,
      revision,
      state: "Ready",
      approved: null,
      completionConfirmed: null,
    });
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
    if (mode === "invalid") return json(422, { code: "invalid_document" });
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
await context.route("**/api/v1/**", api);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
const url = `${base}/?projectId=${fixture.projectId}`;
const status = page.locator(".save-state");
async function projectOption(name) {
  await page.getByLabel("Project options", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
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
    () => document.querySelector(".save-state")?.dataset.state === "saved",
  );
}

async function chooseRecovery() {
  const recovery = page.getByRole("button", { name: "Keep Recovery and Exit", exact: true });
  if (!(await recovery.isVisible())) {
    await page.getByRole("button", { name: "Exit", exact: true }).click();
  }
  await recovery.click();
}

async function catalogueScenario(capability, revokeDuringRead = false, companion = "none") {
  const approvedId = "22222222-2222-4222-8222-222222222222";
  const retainedId = "33333333-3333-4333-8333-333333333333";
  const modelId = "44444444-4444-4444-8444-444444444444";
  const manifest = JSON.parse(
    readFileSync(new URL("../../../assets/manifest.json", import.meta.url), "utf8"),
  );
  const hash = manifest.assets.find((asset) => asset.assetId === "test-room-module-v1").sha256;
  const approved = {
    id: approvedId,
    name: "Approved Starter room",
    kind: "environment",
    url: `/api/v1/assets/${approvedId}/bytes`,
    sha256: hash,
    thumbnail: null,
    category: null,
  };
  const retained = {
    id: retainedId,
    name: "Retained object",
    kind: "model",
    url: `/api/v1/projects/${fixture.projectId}/assets/${retainedId}/bytes`,
    sha256: "b".repeat(64),
    thumbnail: null,
    category: null,
  };
  const approvedModel = {
    ...retained,
    id: modelId,
    name: "Approved Starter model",
    url: `/api/v1/assets/${modelId}/bytes`,
    sha256: hash,
  };
  let serverDocument = structuredClone(fixture);
  serverDocument.scenes[0].environmentAssetId = approvedId;
  serverDocument.scenes[0].objects = [
    { ...serverDocument.scenes[0].objects[0], assetId: retainedId },
  ];
  let currentCapability = capability,
    serverRevision = 1;
  const captured = [];
  const isolated = await browser.newContext();
  try {
    await isolated.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (status, body) => route.fulfill({ status, json: body });
      if (path === "/api/v1/auth/session")
        return json(200, {
          userId: alice,
          displayName: "Student",
          role: "Creator",
          orgId: bob,
          mustChangePassword: false,
          ...(currentCapability === undefined
            ? {}
            : { developmentAssetsAllowed: currentCapability }),
        });
      if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
      if (path === "/api/v1/assets") {
        if (revokeDuringRead) currentCapability = false;
        return json(200, [approved, ...(companion === "approved" ? [approvedModel] : [])]);
      }
      if (path === `/api/v1/projects/${fixture.projectId}/assets`)
        return json(200, [
          retained,
          ...(companion === "retained"
            ? [
                {
                  ...approvedModel,
                  url: `/api/v1/projects/${fixture.projectId}/assets/${modelId}/bytes`,
                },
              ]
            : []),
        ]);
      if (path === `/api/v1/projects/${fixture.projectId}`) {
        if (request.method() === "GET")
          return json(200, {
            projectId: fixture.projectId,
            revision: serverRevision,
            document: serverDocument,
            permissions: { canEdit: true },
          });
        const body = request.postDataJSON();
        captured.push(body);
        serverDocument = body.document;
        return json(200, {
          projectId: fixture.projectId,
          clientMutationId: body.clientMutationId,
          revision: ++serverRevision,
        });
      }
      return json(404, {});
    });
    const scenario = await isolated.newPage();
    scenario.setDefaultTimeout(15000);
    const scenarioErrors = [];
    scenario.on("pageerror", (error) => scenarioErrors.push(error.message));
    await scenario.route("**/viewport/Viewport.tsx*", async (route) => {
      const original = await (await route.fetch()).text();
      const react = original.match(/import __vite__cjsImport\d+_react from "([^"]+)"/)[1];
      await route.fulfill({
        contentType: "text/javascript",
        body: `import React from ${JSON.stringify(react)};
          export function Viewport(props) {
            React.useEffect(() => {
              props.onCamera({
                prepareAsset: async (id) => { (window.preparedAssets ??= []).push(id); return true; },
                capture: () => ({position: [0, 1, 0], rotation: [0, 0, 0, 1], fovDegrees: 40}),
                show() {}, locate() {}, toggleDisplayMedia() {}, hotspotAnchor() {}, bounds() { return null; },
              });
              props.onStatus("ready");
              return () => props.onCamera(null);
            }, []);
            return React.createElement("div", null, React.createElement("button", {
              className: "viewport-stage",
              "data-placing-asset": props.placingAssetId ?? "",
              onClick: () => props.onPlace(props.placingAssetId, [7.46, 0, -5.35]),
            }, "Place"), props.children);
          }`,
      });
    });
    await scenario.goto(url);
    if (revokeDuringRead) {
      await scenario
        .getByRole("alert")
        .getByText(/account changed/i)
        .waitFor();
      assert.equal(await scenario.locator(".editor-shell").count(), 0);
      return;
    }
    await scenario
      .getByRole("button", { name: "Rooms", exact: true })
      .waitFor()
      .catch(async (error) => {
        console.error(scenarioErrors, await scenario.locator("body").innerText());
        throw error;
      });
    await scenario.getByRole("button", { name: "Asset library", exact: true }).click();
    assert.equal(
      await scenario
        .locator(".asset-picker")
        .getByRole("button", { name: "Retained object", exact: true })
        .count(),
      0,
      "Retained references can open the project without becoming new choices",
    );
    assert.equal(
      await scenario
        .locator(".asset-picker")
        .getByRole("button", { name: "Approved Starter model", exact: true })
        .count(),
      0,
      "Room companions are offered through Rooms, not as ordinary objects",
    );
    await scenario.getByRole("button", { name: "Close asset library" }).click();
    await scenario.getByRole("button", { name: "Rooms", exact: true }).click();
    const rooms = scenario.getByRole("group", { name: "Rooms options", exact: true });
    assert.equal(
      await rooms.getByRole("button", { name: "Starter room", exact: true }).count(),
      capability === true ? 1 : 0,
      "Bundled Starter room requires explicit development capability",
    );
    assert.equal(
      await rooms.getByRole("button", { name: "All 4 Doors", exact: true }).count(),
      capability === true ? 1 : 0,
      "Bundled room layouts require explicit development capability",
    );
    assert.equal(
      await rooms.locator(".room-picker-hint").innerText(),
      "Choose a room to add it to your scene. Adding another room requires an approved room model.",
    );
    await rooms.getByRole("button", { name: "Approved Starter room", exact: true }).click();
    if (capability === true || companion === "approved") {
      await scenario.waitForFunction(
        (id) =>
          document.querySelector(".viewport-stage")?.getAttribute("data-placing-asset") === id,
        approvedId,
      );
      assert.equal(
        await scenario.locator(".viewport-stage").getAttribute("data-placing-asset"),
        approvedId,
      );
      assert.deepEqual(await scenario.evaluate(() => window.preparedAssets), [
        capability === true ? "test-room-module-v1" : modelId,
      ]);
      await scenario.locator(".viewport-stage").click();
    } else {
      await scenario
        .getByRole("alert")
        .filter({ hasText: /approved.*room.*model/i })
        .waitFor();
      assert.deepEqual(await scenario.evaluate(() => window.preparedAssets ?? []), []);
    }
    const name = `Catalogue capability ${String(capability)}`;
    await scenario.getByRole("button", { name: "Scenes", exact: true }).click();
    await scenario.getByLabel("Scene name", { exact: true }).fill(name);
    await scenario.getByRole("button", { name: "Rename scene", exact: true }).click();
    const deadline = Date.now() + 15000;
    while (!captured.some((entry) => entry.document.scenes[0].name === name)) {
      if (Date.now() >= deadline) throw new Error("The approved-room project did not save");
      await scenario.waitForTimeout(100);
    }
    const written = captured.find((entry) => entry.document.scenes[0].name === name).document;
    assert.equal(written.scenes[0].environmentAssetId, approvedId);
    assert.deepEqual(
      written.scenes[0].objects.map((object) => object.assetId),
      capability === true
        ? [retainedId, "test-room-module-v1"]
        : companion === "approved"
          ? [retainedId, modelId]
          : [retainedId],
      "Production uses the active approved model UUID and never inserts a bundled module",
    );
  } finally {
    await isolated.close();
  }
}
async function importScenario() {
  const isolated = await browser.newContext();
  const incoming = { ...structuredClone(fixture), title: "Imported copy" };
  const importedId = "55555555-5555-4555-8555-555555555555";
  let lostReceipt = true;
  const imports = [];
  await isolated.route("**/api/v1/**", async (route) => {
    if (
      new URL(route.request().url()).pathname === "/api/v1/projects" &&
      route.request().method() === "POST"
    ) {
      imports.push(route.request().postDataJSON());
      return route.fulfill(
        lostReceipt
          ? { status: 503, json: {} }
          : {
              status: 201,
              json: {
                projectId: importedId,
                revision: 0,
                archived: false,
                updatedAt: new Date().toISOString(),
              },
            },
      );
    }
    return api(route);
  });
  try {
    const editor = await isolated.newPage();
    await editor.goto(url);
    await editor.locator('.save-state[data-state="saved"]').waitFor();
    await editor.getByLabel("Project options", { exact: true }).click();
    assert.equal(
      await editor.locator("#project-save").count(),
      0,
      "Server autosave has no redundant Save menu item",
    );
    await editor.getByRole("button", { name: "Import", exact: true }).waitFor();
    await editor.getByRole("button", { name: "Export", exact: true }).waitFor();
    const upload = async (text) =>
      editor.locator("#project-import").setInputFiles({
        name: "project.json",
        mimeType: "application/json",
        buffer: Buffer.from(text),
      });
    await upload("{}");
    await editor.locator(".server-session-error").waitFor();
    assert.equal(imports.length, 0, "Malformed imports never reach project creation");
    const original = JSON.stringify(document);
    await upload(JSON.stringify(incoming));
    await editor.getByRole("alert").filter({ hasText: "Import could not be confirmed" }).waitFor();
    assert.equal(imports.length, 1);
    await upload(JSON.stringify(incoming));
    await editor
      .getByRole("alert")
      .filter({ hasText: "earlier creation may have completed" })
      .waitFor();
    assert.equal(imports.length, 1, "Uncertain imports do not create duplicates on retry");
    // The existing All Projects reconciliation clears this same guard after checking creation
    await editor.evaluate(
      (key) => sessionStorage.removeItem(key),
      `spatia:uncertain-project-creation:${alice}`,
    );
    lostReceipt = false;
    await upload(JSON.stringify(incoming));
    await editor.waitForURL(`**/?projectId=${importedId}`);
    assert.equal(imports[1].title, incoming.title);
    assert.equal(imports[1].document.projectId, incoming.projectId);
    assert.equal(imports[1].orgId, bob);
    assert.equal(
      JSON.stringify(document),
      original,
      "Import creates a new project and preserves the current server draft",
    );
  } finally {
    await isolated.close();
  }
}

try {
  // Real IndexedDB must not reuse a cleared revision while another tab holds it.
  const recoveryContext = await browser.newContext();
  try {
    const recoveryPage = await recoveryContext.newPage();
    await recoveryPage.goto(base);
    const result = await recoveryPage.evaluate(
      async ({ project, accountId }) => {
        const { applySaveRecoverySession, clearConfirmedServerRecovery, getRecoverySession } =
          await import("/persistence/recovery-session.ts");
        const { IndexedDBDraftDatabase } = await import("/persistence/draft-db.ts");
        const database = new IndexedDBDraftDatabase();
        const assets = new Map([
          ["test-room-v1", "environment"],
          ["test-crate-v1", "model"],
        ]);
        const scope = { accountId, projectId: project.projectId };
        const backup = { document: project };
        const first = await applySaveRecoverySession(backup, 0, assets, database, scope);
        const connection = await database.getIndexedDB();
        const encoded = await new Promise((resolve, reject) => {
          const tx = connection.transaction("session", "readonly");
          const read = tx.objectStore("session").get(["account", accountId, project.projectId]);
          tx.oncomplete = () => {
            connection.close();
            resolve(read.result.document);
          };
          tx.onabort = () => {
            connection.close();
            reject(tx.error);
          };
        });
        const confirmed = {
          ...backup,
          serverSave: { revision: 7, confirmedJson: encoded, pending: null },
        };
        const second = await applySaveRecoverySession(confirmed, 1, assets, database, scope);
        const cleared = await clearConfirmedServerRecovery(scope);
        const reopened = await getRecoverySession(assets, database, scope);
        if (!reopened.ok || !reopened.value) throw new Error("Cleared revision was not retained");
        const newer = { ...confirmed, document: { ...project, title: "New tab's offline work" } };
        const next = await applySaveRecoverySession(
          newer,
          reopened.value.revision,
          assets,
          database,
          scope,
        );
        const stale = await applySaveRecoverySession(
          { ...confirmed, document: { ...project, title: "Stale tab" } },
          2,
          assets,
          database,
          scope,
        );
        const retained = await getRecoverySession(assets, database, scope);
        return { first, second, cleared, reopened, next, stale, retained };
      },
      {
        project: fixture,
        accountId: alice,
      },
    );
    assert.deepEqual(result.first, { ok: true, value: 1 });
    assert.deepEqual(result.second, { ok: true, value: 2 });
    assert.deepEqual(result.cleared, { ok: true, value: true });
    assert.equal(result.reopened.value.revision, 2);
    assert.equal(result.reopened.value.document, null);
    assert.deepEqual(result.next, { ok: true, value: 3 });
    assert.equal(result.stale.ok, false);
    assert.equal(result.retained.value.document.title, "New tab's offline work");
  } finally {
    await recoveryContext.close();
  }
  // A second editor must not commit while the first file writer is open.
  const fileContext = await browser.newContext();
  try {
    const filePage = await fileContext.newPage();
    await filePage.goto(base);
    const overlap = await filePage.evaluate(async () => {
      const { writeProjectFile } = await import("/persistence/project-files.ts");
      const handle = await (
        await navigator.storage.getDirectory()
      ).getFileHandle("overlap.json", { create: true });
      const initial = await handle.createWritable();
      await initial.write("original");
      await initial.close();
      let release;
      let created;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const opened = new Promise((resolve) => {
        created = resolve;
      });
      let writerMode;
      const delayed = {
        kind: handle.kind,
        name: handle.name,
        getFile: () => handle.getFile(),
        createWritable: async (...args) => {
          const stream = await handle.createWritable(...args);
          writerMode = stream.mode ?? null;
          created();
          return {
            write: (text) => stream.write(text),
            close: async () => {
              await held;
              await stream.close();
            },
            abort: () => stream.abort(),
          };
        },
      };
      const first = writeProjectFile(delayed, "first", "original");
      await opened;
      let secondSucceeded = true;
      try {
        await writeProjectFile(handle, "second", "original");
      } catch {
        secondSucceeded = false;
      } finally {
        release();
      }
      await first;
      const afterFirst = await (await handle.getFile()).text();
      let staleSucceeded = true;
      try {
        await writeProjectFile(handle, "stale", "original");
      } catch {
        staleSucceeded = false;
      }
      await writeProjectFile(handle, "follow-up", "first");
      return {
        secondSucceeded,
        staleSucceeded,
        afterFirst,
        finalText: await (await handle.getFile()).text(),
        writerMode,
      };
    });
    assert.equal(
      overlap.secondSucceeded,
      false,
      `The overlapping writer must be rejected: ${JSON.stringify(overlap)}`,
    );
    assert.equal(overlap.afterFirst, "first");
    assert.equal(overlap.staleSucceeded, false);
    assert.equal(overlap.finalText, "follow-up");
  } finally {
    await fileContext.close();
  }
  await catalogueScenario(false, false, "approved");
  for (const capability of [false, undefined, true]) await catalogueScenario(capability);
  await catalogueScenario(false, false, "retained");
  await catalogueScenario(true, true);
  await page.goto(url);
  await page.getByRole("button", { name: "Retry opening" }).waitFor();
  assert.equal(await page.locator(".editor-shell").count(), 0);
  catalogueUnavailable = false;
  await page.getByRole("button", { name: "Retry opening" }).click();
  await saved();
  await importScenario();
  assert.equal(await page.getByRole("complementary", { name: "Server project" }).count(), 0);
  await page.getByRole("button", { name: "Leave editor" }).focus();
  await page.keyboard.press("Enter");
  // An unchanged server draft leaves directly without a redundant confirmation
  await page.waitForURL(`${base}/home`, { timeout: 5000 });
  await page.goto(url);
  await saved();
  await ready();
  await page.screenshot({ path: ".artifacts/scrum67-editor.png" });
  await edit("Autosaved in the real editor");
  await saved();
  assert.equal(document.scenes[0].name, "Autosaved in the real editor");
  assert.equal(writes.length, 1);
  // A definite validation rejection survives reload without replaying stale bytes.
  mode = "invalid";
  const beforeInvalid = writes.length;
  await edit("Rejected draft retained for correction");
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "Save needs changes. Check your document and assets, then try again. Your edits are still here.",
    })
    .waitFor();
  const rejected = writes.at(-1);
  assert.equal(rejected.document.scenes[0].name, "Rejected draft retained for correction");
  assert.notEqual(document.scenes[0].name, rejected.document.scenes[0].name);
  await page.reload();
  await page.getByRole("dialog", { name: "Recover your changes?" }).waitFor();
  await page.getByRole("button", { name: "Recover changes", exact: true }).click();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Rejected draft retained for correction",
  );
  mode = "saved";
  await edit("Corrected draft retained after rejection");
  await saved();
  assert.equal(writes.length, beforeInvalid + 2);
  const corrected = writes.at(-1);
  assert.notEqual(corrected.clientMutationId, rejected.clientMutationId);
  assert.equal(corrected.expectedRevision, rejected.expectedRevision);
  assert.equal(corrected.document.scenes[0].name, "Corrected draft retained after rejection");
  assert.equal(document.scenes[0].name, "Corrected draft retained after rejection");
  // Leaving keeps changed work behind the same preservation choices
  mode = "failed";
  await edit("Draft before publishing");
  await page.locator('.save-state[data-state="failed"]').waitFor();
  await page.getByRole("alert").filter({ hasText: "Save failed" }).waitFor();
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await page.getByRole("button", { name: /^(Cancel|Keep editing)$/ }).click();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Draft before publishing",
  );
  assert.notEqual(document.scenes[0].name, "Draft before publishing");
  mode = "saved";
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.waitForURL(`${base}/home`);
  assert.equal(document.scenes[0].name, "Draft before publishing");
  await page.goto(url);
  await saved();
  await ready();
  // A fresh browser opens the confirmed server content without local recovery.
  const freshContext = await browser.newContext();
  await freshContext.route("**/api/v1/**", api);
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
  await page.locator('.save-state[data-state="failed"]').waitFor();
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  assert.equal(new URL(page.url()).searchParams.get("projectId"), fixture.projectId);
  await page.getByRole("button", { name: /^(Cancel|Keep editing)$/ }).click();
  const failedMutation = writes.at(-1).clientMutationId;
  mode = "saved";
  await projectOption("Retry Save");
  await saved();
  assert.equal(writes.at(-1).clientMutationId, failedMutation);
  assert.equal(document.scenes[0].name, "Offline edit");
  mode = "conflict";
  await edit("Conflicting local edit");
  await page.getByRole("alert").filter({ hasText: "Another revision" }).waitFor();
  const attempts = writes.length;
  // Native export cancellation must not permit logout.
  await page.evaluate(() => {
    window.showSaveFilePicker = async () => {
      throw new DOMException("Cancelled", "AbortError");
    };
  });
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.getByRole("button", { name: "Export and Exit", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  await page.getByRole("button", { name: /^(Cancel|Keep editing)$/ }).click();
  await projectOption("Open Server Version");
  await chooseRecovery();
  await page.getByRole("dialog", { name: "Recover your changes?" }).waitFor();
  assert.equal(writes.length, attempts);
  await page.getByRole("button", { name: "Recover changes", exact: true }).click();
  await ready();
  assert.equal(
    await page.getByLabel("Scene name", { exact: true }).inputValue(),
    "Conflicting local edit",
  );
  await page.getByRole("alert").filter({ hasText: "Another revision" }).waitFor();
  await projectOption("Open Server Version");
  await chooseRecovery();
  mode = "saved";
  await page.getByRole("button", { name: "Use saved version", exact: true }).click();
  await saved();
  await ready();
  assert.equal(await page.getByLabel("Scene name", { exact: true }).inputValue(), "Offline edit");
  // An acknowledgement for an older edit must not mark newer work saved.
  mode = "delayed";
  await edit("First edit while saving");
  await page.locator('.save-state[data-state="saving"]').waitFor();
  while (!releaseSave) await new Promise((resolve) => setTimeout(resolve, 10));
  await edit("Newer edit while saving");
  assert.notEqual(await status.getAttribute("data-state"), "saved");
  mode = "saved";
  releaseSave();
  await saved();
  assert.equal(document.scenes[0].name, "Newer edit while saving");

  // Expiry redirects only after preserving unsynced edits for the original account.
  mode = "failed";
  await edit("Draft retained after sign-out");
  await page.locator('.save-state[data-state="failed"]').waitFor();
  account = null;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForURL(
    `${base}/login?returnTo=${encodeURIComponent(`/?projectId=${fixture.projectId}`)}`,
  );
  await page.getByRole("heading", { name: "Welcome back.", exact: true }).waitFor();
  account = alice;
  mode = "saved";
  await page.goto(url);
  await page.getByRole("button", { name: "Recover changes", exact: true }).click();
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
  await page.locator('.save-state[data-state="failed"]').waitFor();
  assert.equal(writes.length, beforeStorageFailure);
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await chooseRecovery();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(account, alice);
  await page.getByRole("button", { name: /^(Cancel|Keep editing)$/ }).click();
  await page.evaluate(() => {
    window.failRecovery = false;
  });
  await projectOption("Retry Save");
  await saved();
  assert.equal(document.scenes[0].name, "Storage failure edit");

  // Expiry plus a failed final backup must retain the only live draft behind its owner.
  await page.evaluate(() => {
    window.failRecovery = true;
  });
  await edit("Only live draft after expiry");
  await page.locator('.save-state[data-state="failed"]').waitFor();
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
  const [download] = await Promise.all([page.waitForEvent("download"), projectOption("Export")]);
  assert.equal(
    JSON.parse(readFileSync(await download.path(), "utf8")).scenes[0].name,
    "Only live draft after expiry",
  );
  // Changing cookies must hide the old editor and keep recovery in its original account.
  mode = "failed";
  await edit("Alice private edit");
  await page.locator('.save-state[data-state="failed"]').waitFor();
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
  // Confirmed autosave permits departure while final backup still holds the editor locked
  await page.getByRole("button", { name: "Leave editor", exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseDeparture === "function");
  await page.keyboard.press("Control+z");
  assert.equal(await departureName.evaluate((input) => input.value), "Preserved departure edit");
  await page.evaluate(() => window.releaseDeparture());
  await page.waitForURL("**/home");
  assert.equal(account, bob);
  assert.deepEqual(errors, []);
  console.log(
    "Actual editor autosave, fresh open, retry identity, conflict/recovery choices, cancelled export/departure, delayed acknowledgements, expiry redirects with draft recovery, storage failure, successful departure and account isolation passed.",
  );
} finally {
  await browser.close();
}
