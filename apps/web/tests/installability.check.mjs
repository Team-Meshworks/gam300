import assert from "node:assert/strict";
import { launchBrowser } from "./browser-security.mjs";

const root = new URL("/", process.argv[2] ?? "http://127.0.0.1:4173/").href;
const id = "11111111-1111-4111-8111-111111111111";
const browser = await launchBrowser({ target: root });
try {
  const page = await browser.newPage({ javaScriptEnabled: false });
  const devtools = await page.context().newCDPSession(page);
  const manifestUrl = new URL("/manifest.webmanifest", root).href;
  for (const [path, title] of [
    ["/", "Spatia"],
    ["/landing", "Spatia"],
    ["/spaces", "Spatia workspace"],
    [`/?projectId=${id}`, "Spatia"],
    [`/p/${id}`, "Exhibition · Spatia"],
  ]) {
    const response = await page.goto(new URL(path, root).href);
    assert.equal(response.status(), 200, path);
    assert.equal(await page.title(), title, path);
    const { url, errors } = await devtools.send("Page.getAppManifest");
    assert.equal(url, manifestUrl, path);
    assert.deepEqual(errors, [], path);
  }

  const contentType = await page.evaluate(
    async (url) => (await fetch(url)).headers.get("content-type"),
    manifestUrl,
  );
  assert.equal(contentType?.split(";")[0], "application/manifest+json");
  const { data, manifest } = await devtools.send("Page.getAppManifest");
  assert.equal(manifest.name, "Spatia");
  assert.equal(manifest.id, root);
  assert.equal(manifest.startUrl, root);
  assert.equal(manifest.scope, root);
  assert.equal(JSON.parse(data).display, "standalone");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert.equal(icon?.type, "image/png");
    const dimensions = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, icon.url);
    assert.deepEqual(dimensions, [size, size]);
  }
} finally {
  await browser.close();
}
