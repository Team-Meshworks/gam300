import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { launchBrowser } from "../../web/tests/browser-security.mjs";

const api = new URL(process.argv[2]);
assert.equal(api.protocol, "https:");
assert.equal(api.hostname, "127.0.0.1");
const data = JSON.parse(process.argv[3]);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
const origin = `https://127.0.0.1:${port}`;
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: path.resolve("../web"),
    env: {
      ...process.env,
      SPATIA_API_ORIGIN: api.origin,
      SPATIA_DEV_TLS_CERT: data.certificate,
      SPATIA_DEV_TLS_KEY: data.key,
      SPATIA_API_CA: data.certificate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let viteOutput = "";
vite.stdout.on("data", (chunk) => {
  viteOutput += chunk;
});
vite.stderr.on("data", (chunk) => {
  viteOutput += chunk;
});
const ca = readFileSync(data.certificate);
async function ready() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite stopped: ${viteOutput}`);
    const ok = await new Promise((resolve) => {
      const request = https.get(origin + "/login", { ca }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteOutput}`);
}
let browser;
try {
  await ready();
  browser = await launchBrowser({
    target: origin,
    args: ["--enable-unsafe-swiftshader"],
    verificationOutput: "stdout",
  });
  console.log(`Node ${process.version}; Chromium ${browser.version()}`);
  const pages = {};
  for (const name of ["educator", "viewer", "unrelated"]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (name === "educator")
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    pages[name] = await context.newPage();
    pages[name].setDefaultTimeout(15000);
  }
  async function login(page, name) {
    await page.getByLabel("Username", { exact: true }).fill(data[name]);
    await page
      .getByLabel("Password", { exact: true })
      .fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
  }
  const educator = pages.educator;
  await educator.goto(`${origin}/login`);
  await login(educator, "educator");
  await educator.getByRole("heading", { name: /you.re signed in/i }).waitFor();
  await educator.goto(`${origin}/publish?projectId=${data.projectId}`);
  await educator.getByRole("heading", { name: "Publish project" }).waitFor();
  await educator.getByText("Student draft", { exact: true }).waitFor();
  await educator
    .getByRole("checkbox", { name: data.viewer, exact: true })
    .check();
  await educator
    .getByRole("checkbox", { name: /confirm.*saved revision/i })
    .check();
  const posted = educator.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/api/v1/projects/${data.projectId}/publications`,
  );
  await educator.getByRole("button", { name: "Publish", exact: true }).click();
  const request = (await posted).postDataJSON();
  assert.equal(request.confirmedRevision, 0);
  assert.deepEqual(request.intent, {
    audience: "Authenticated",
    viewerIds: [data.viewerId],
  });
  const link = educator.getByRole("link", { name: "Open publication" });
  await link.waitFor();
  const linkValue = await link.getAttribute("href");
  assert.equal(
    linkValue,
    `https://publications.example.test/p/${request.publicationId}`,
  );
  await educator.getByRole("button", { name: "Copy link" }).click();
  await educator
    .getByRole("status")
    .filter({ hasText: "Link copied." })
    .waitFor();
  const copy = await educator.evaluate(() => navigator.clipboard.readText());
  assert.equal(copy, linkValue);
  const localVisitor = `${origin}${new URL(copy).pathname}`;
  const viewer = pages.viewer;
  await viewer.goto(localVisitor);
  await viewer
    .getByRole("heading", { name: "Exhibition unavailable" })
    .waitFor();
  await viewer
    .getByRole("link", { name: "Sign in to view exhibition" })
    .click();
  assert.equal(
    new URL(viewer.url()).searchParams.get("returnTo"),
    `/p/${request.publicationId}`,
  );
  await login(viewer, "viewer");
  await viewer.waitForURL(localVisitor);
  await viewer.getByRole("heading", { name: "Student draft" }).waitFor();
  await viewer
    .getByRole("status")
    .getByText("Exhibition ready")
    .waitFor({ timeout: 30000 });
  assert.equal(
    await viewer.locator("canvas[aria-label='Exhibition view']").count(),
    1,
  );
  const snapshot = `/api/v1/publications/${request.publicationId}`;
  const assetPath = `${snapshot}/assets/${data.assetId}/bytes`;
  const read = (page, route) =>
    page.evaluate(async (route) => {
      const response = await fetch(route);
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, route);
  const write = (page, route, body) =>
    page.evaluate(
      async ({ route, body }) => {
        const token = (await (await fetch("/api/v1/auth/csrf")).json())
          .requestToken;
        const response = await fetch(route, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-TOKEN": token,
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: await response.json().catch(() => null),
        };
      },
      { route, body },
    );
  const replay = await write(
    educator,
    `/api/v1/projects/${data.projectId}/publications`,
    request,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.visitorUrl, linkValue);
  assert.equal(
    (
      await write(educator, `/api/v1/projects/${data.projectId}/publications`, {
        ...request,
        intent: { audience: "Authenticated", viewerIds: [] },
      })
    ).status,
    409,
  );
  for (const audience of ["Public", "Unlisted"])
    assert.equal(
      (
        await write(educator, `${snapshot}/access`, {
          audience,
          viewerIds: [],
          action: "audience",
        })
      ).status,
      503,
    );
  assert.equal((await read(educator, snapshot)).status, 200);
  assert.equal(
    (await read(viewer, `/api/v1/projects/${data.projectId}`)).status,
    404,
  );
  const asset = await read(viewer, assetPath);
  assert.equal(asset.status, 200);
  assert.equal(
    createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex"),
    data.assetHash,
  );
  const outsider = pages.unrelated;
  await outsider.goto(localVisitor);
  await outsider
    .getByRole("link", { name: "Sign in to view exhibition" })
    .click();
  await login(outsider, "unrelated");
  await outsider.waitForURL(localVisitor);
  await outsider
    .getByRole("heading", { name: "Exhibition unavailable" })
    .waitFor();
  assert.equal((await read(outsider, snapshot)).status, 404);
  assert.equal((await read(outsider, assetPath)).status, 404);
  // Publish a second edition so revocation cannot affect the first edition's restart checks.
  await educator.reload();
  await educator.getByRole("heading", { name: "Publish project" }).waitFor();
  await educator.getByRole("checkbox", { name: data.viewer, exact: true }).check();
  await educator.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  const secondPost = educator.waitForRequest(
    (item) =>
      item.method() === "POST" &&
      new URL(item.url()).pathname === `/api/v1/projects/${data.projectId}/publications`,
  );
  await educator.getByRole("button", { name: "Publish", exact: true }).click();
  const secondRequest = (await secondPost).postDataJSON();
  assert.notEqual(secondRequest.publicationId, request.publicationId);
  assert.deepEqual(secondRequest.intent, { audience: "Authenticated", viewerIds: [data.viewerId] });
  await educator.getByRole("link", { name: "Open publication" }).waitFor();
  const secondLink = educator.getByRole("link", { name: "Open publication" });
  const secondQr = educator.getByRole("img", { name: /QR code/i });
  assert.equal(await secondLink.isVisible(), true);
  assert.equal(await secondQr.isVisible(), true);
  const secondSnapshot = `/api/v1/publications/${secondRequest.publicationId}`;
  assert.equal(
    (await read(viewer, secondSnapshot)).status,
    200,
    "Named viewer can read the second edition before revocation",
  );

  const accessSection = educator.getByRole("region", { name: "Manage publication access" });
  await accessSection
    .getByRole("textbox", { name: "Publication link or ID" })
    .fill(secondRequest.publicationId);
  await accessSection.getByRole("button", { name: "Check access" }).click();
  await accessSection.getByText("Access active", { exact: true }).waitFor();
  await accessSection.getByRole("button", { name: "Revoke access" }).click();
  const confirmation = accessSection.getByRole("group", { name: "Confirm revocation" });
  const revoked = educator.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `${secondSnapshot}/access`,
  );
  await confirmation.getByRole("button", { name: "Confirm revoke" }).click();
  const revokeResponse = await revoked;
  assert.equal(revokeResponse.status(), 204);
  assert.deepEqual(revokeResponse.request().postDataJSON(), {
    audience: "Authenticated",
    viewerIds: [data.viewerId],
    action: "revoke",
  });
  await accessSection.getByText("Access revoked", { exact: true }).waitFor();
  assert.equal(await secondLink.count(), 0, "Revocation removes the second edition's share link");
  assert.equal(await secondQr.count(), 0, "Revocation removes the second edition's QR code");
  assert.equal(
    (await read(viewer, secondSnapshot)).status,
    404,
    "Named viewer cannot read the revoked edition",
  );
  assert.equal((await read(viewer, `${secondSnapshot}/assets/${data.assetId}/bytes`)).status, 404);
  assert.equal(
    (await read(viewer, snapshot)).status,
    200,
    "Revocation leaves the first edition available",
  );
  console.log(
    "browser publication API passed: UI publication, named viewer login and rendered exhibition, outsider denial and asset integrity",
  );
} finally {
  await browser?.close();
  vite.kill();
  await new Promise((resolve) => {
    if (vite.exitCode !== null) resolve();
    else vite.once("exit", resolve);
  });
}
