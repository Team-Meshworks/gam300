import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Called inside the existing disposable HTTPS/PostgreSQL fixture. Only static editor
// files are built into its private static directory; login, reads, saves and
// conflicts use the real API. No asset bodies cross Playwright's DevTools pipe.
export async function checkServerEditor(
  browser,
  origin,
  accounts,
  build,
  webRoot,
  editorDirectory,
) {
  const built = await build({
    configFile: webRoot + "vite.config.ts",
    logLevel: "silent",
    build: { write: true, outDir: editorDirectory, emptyOutDir: false },
  });
  const output = (Array.isArray(built) ? built[0] : built).output;
  const largest = output
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".glb"))
    .sort(
      (a, b) => Buffer.byteLength(b.source) - Buffer.byteLength(a.source),
    )[0];
  assert.ok(
    largest,
    "The actual catalogue must be present in the editor build",
  );
  const asset = {
    path: "/" + largest.fileName,
    bytes: Buffer.byteLength(largest.source),
    sha256: createHash("sha256").update(largest.source).digest("hex"),
  };
  const contexts = [];
  const open = async (account, verifyTransport = false) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    // The shared browser launcher already limits networking to this exact local origin.
    const page = await context.newPage();
    await page.goto(origin + "/_test/browser");
    if (verifyTransport) {
      assert.equal(
        await page.evaluate(
          async (path) => (await fetch(path, { method: "HEAD" })).status,
          asset.path,
        ),
        401,
      );
    }
    const login = await page.evaluate(async (userName) => {
      const csrf = (await (await fetch("/api/auth/csrf")).json()).requestToken;
      return (
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrf },
          body: JSON.stringify({
            userName,
            password: "Synthetic-long-password1!",
          }),
        })
      ).status;
    }, account.userName);
    assert.equal(login, 204);
    if (verifyTransport) {
      // Return only byte counts/digests to the driver, never the large response body.
      const delivered = await page.evaluate(async (path) => {
        const response = await fetch(path);
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const partial = await fetch(path, { headers: { Range: "bytes=0-11" } });
        const header = new DataView(await partial.arrayBuffer());
        return {
          status: response.status,
          bytes: bytes.byteLength,
          sha256: Array.from(new Uint8Array(hash), (value) =>
            value.toString(16).padStart(2, "0"),
          ).join(""),
          rangeStatus: partial.status,
          range: partial.headers.get("content-range"),
          magic: header.getUint32(0, true),
          declaredBytes: header.getUint32(8, true),
        };
      }, asset.path);
      assert.equal(delivered.status, 200);
      assert.equal(delivered.bytes, asset.bytes);
      assert.equal(delivered.sha256, asset.sha256);
      assert.equal(delivered.rangeStatus, 206);
      assert.equal(delivered.range, `bytes 0-11/${asset.bytes}`);
      assert.equal(delivered.magic, 0x46546c67);
      assert.equal(delivered.declaredBytes, asset.bytes);
      console.log(
        `largest catalogue asset streamed over HTTPS: ${asset.bytes} bytes; full hash and range verified`,
      );
    }
    await page.goto(origin + "/_test/editor?projectId=" + account.projectId);
    await page.getByText("Scene ready", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    return page;
  };
  try {
    const page = await open(accounts[0], true);
    await page
      .getByLabel("Scene name", { exact: true })
      .fill("SCRUM-67 actual editor save");
    await page
      .getByRole("button", { name: "Rename scene", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('.server-session [role="status"]')
          ?.textContent === "Saved to server",
    );
    const fresh = await open(accounts[0]);
    assert.equal(
      await fresh.getByLabel("Scene name", { exact: true }).inputValue(),
      "SCRUM-67 actual editor save",
    );
    // The second authenticated editor creates a real revision conflict in the first.
    await fresh
      .getByLabel("Scene name", { exact: true })
      .fill("Another editor's saved revision");
    await fresh
      .getByRole("button", { name: "Rename scene", exact: true })
      .click();
    await fresh.waitForFunction(
      () =>
        document.querySelector('.server-session [role="status"]')
          ?.textContent === "Saved to server",
    );
    await page
      .getByLabel("Scene name", { exact: true })
      .fill("Keep these conflicting edits");
    await page
      .getByRole("button", { name: "Rename scene", exact: true })
      .click();
    await page
      .locator('.server-session [role="status"]')
      .filter({ hasText: "Another revision" })
      .waitFor();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page
      .getByRole("button", { name: "Save and continue", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("alert").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(
      await page.getByLabel("Scene name", { exact: true }).inputValue(),
      "Keep these conflicting edits",
    );
    console.log(
      "actual editor + PostgreSQL: autosave, fresh authenticated reopen, concurrent conflict and blocked logout passed",
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
}
