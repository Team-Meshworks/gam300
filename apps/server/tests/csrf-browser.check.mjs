import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const origin = target.origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "../../web/node_modules/playwright/index.mjs");
const userId = process.argv[3];
const browser = await chromium.launch();
process.stdout.write(`node ${process.version}; chromium ${browser.version()}\n`);
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin + "/_test/browser");
  const result = await page.evaluate(async (id) => {
    const token = async () => (await (await fetch("/api/auth/csrf")).json()).requestToken;
    const write = async (path, csrf) => (await fetch(path, {
      method: "POST", credentials: "same-origin", headers: {
        "Content-Type": "application/json", ...(csrf ? { "X-CSRF-TOKEN": csrf } : {}),
      }, body: JSON.stringify({ value: "synthetic browser request" }),
    })).status;
    const anonymous = await token();
    const missing = await write("/_test/anonymous-write");
    const signedIn = await write("/_test/signin/" + id, anonymous);
    const stale = await write("/_test/write", anonymous);
    const refreshed = await token();
    const valid = await write("/_test/write", refreshed);
    return { missing, signedIn, stale, valid, receivedToken: Boolean(refreshed), cookiesHidden: document.cookie === "" };
  }, userId);
  assert.equal(result.missing, 400);
  assert.equal(result.signedIn, 204);
  assert.equal(result.stale, 400);
  assert.equal(result.valid, 204);
  assert.equal(result.receivedToken, true);
  assert.equal(result.cookiesHidden, true);
  const cookies = await context.cookies();
  for (const name of ["__Host-Spatia.Application", "__Host-Spatia.Antiforgery"]) {
    const cookie = cookies.find((entry) => entry.name === name);
    assert.equal(Boolean(cookie), true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
  }
  await context.close();
  process.stdout.write("browser csrf boundary passed\n");
} finally {
  await browser.close();
}
