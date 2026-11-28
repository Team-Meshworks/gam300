import assert from "node:assert/strict";
import { blankProject } from "./authoring-project-fixture.mjs";
import { launchPersistentBrowser } from "./browser-security.mjs";

const root = new URL("/", process.argv[2] ?? "http://127.0.0.1:4173/").href;
const publicationId = "11111111-1111-4111-8111-111111111111";
const exhibitionPath = `/p/${publicationId}`;
const context = await launchPersistentBrowser({
  target: root,
  args: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  const manifestUrl = new URL("/manifest.webmanifest", root).href;
  await devtools.send("Emulation.setScriptExecutionDisabled", { value: true });
  for (const [path, title] of [
    ["/", "Spatia"],
    ["/landing", "Spatia"],
    ["/spaces", "Spatia workspace"],
    [`/?projectId=${blankProject.projectId}`, "Spatia"],
    [exhibitionPath, "Exhibition · Spatia"],
  ]) {
    const response = await page.goto(new URL(path, root).href);
    assert.equal(response.status(), 200, path);
    assert.equal(await page.title(), title, path);
    const { url, errors } = await devtools.send("Page.getAppManifest");
    assert.equal(url, manifestUrl, path);
    assert.deepEqual(errors, [], path);
  }

  await devtools.send("Emulation.setScriptExecutionDisabled", { value: false });
  await page.goto(root);
  const { installabilityErrors } = await devtools.send("Page.getInstallabilityErrors");
  assert.deepEqual(installabilityErrors, [], "Chrome must consider the launch URL installable");
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

  const publicationApi = new URL(`/api/v1/publications/${publicationId}`, root).href;
  const exhibition = { ...blankProject, title: "Packaged exhibition" };
  await page.route(publicationApi, (route) => route.fulfill({ json: exhibition }));
  await page.route(`${publicationApi}/manifest`, (route) =>
    route.fulfill({
      json: { publicationId, projectId: exhibition.projectId, sourceRevision: 1, assets: [] },
    }),
  );
  const failedScripts = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script" && response.status() >= 400) {
      failedScripts.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(new URL(exhibitionPath, root).href);
  assert.deepEqual(failedScripts, [], "Packaged exhibition scripts must load");
  await page.getByRole("status").getByText("Exhibition ready", { exact: true }).waitFor();
  await page.locator('canvas[aria-label="Exhibition view"]').waitFor();
  assert.equal(await page.title(), `${exhibition.title} · Spatia`);
} finally {
  await context.close();
}
