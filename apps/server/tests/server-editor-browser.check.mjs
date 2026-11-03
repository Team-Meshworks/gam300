import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Called inside the existing disposable HTTPS/PostgreSQL fixture. Only static editor
// files are supplied by this test; login, reads, saves and conflicts use the real API.
export async function checkServerEditor(
  browser,
  origin,
  accounts,
  build,
  webRoot,
) {
  const built = await build({
    configFile: webRoot + "vite.config.ts",
    logLevel: "silent",
    build: { write: false },
  });
  const output = (Array.isArray(built) ? built[0] : built).output;
  const files = new Map(
    output.map((file) => [
      "/" + file.fileName,
      file.type === "chunk" ? file.code : file.source,
    ]),
  );
  // Vite copies public files separately; write:false omits them from the bundle.
  const publicDirectory = webRoot + "editor/public";
  for (const entry of await readdir(publicDirectory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(
      "/" + relative(publicDirectory, path).replaceAll("\\", "/"),
      await readFile(path),
    );
  }
  const contexts = [];
  const open = async (account) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const path =
        url.pathname === "/_test/editor" ? "/index.html" : url.pathname;
      const file = files.get(path);
      if (file === undefined) return route.continue();
      const extension = path.split(".").at(-1);
      return route.fulfill({
        body: file,
        contentType:
          {
            html: "text/html",
            js: "text/javascript",
            css: "text/css",
            svg: "image/svg+xml",
            png: "image/png",
            woff2: "font/woff2",
          }[extension] ?? "application/octet-stream",
      });
    });
    const page = await context.newPage();
    await page.goto(origin + "/_test/browser");
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
    await page.goto(origin + "/_test/editor?projectId=" + account.projectId);
    await page.getByText("Scene ready", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    return page;
  };
  try {
    const page = await open(accounts[0]);
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
