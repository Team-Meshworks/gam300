import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { createRequire } from "node:module";
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
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
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
  for (const name of ["student", "educator", "viewer", "unrelated"]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (name === "student")
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin,
      });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    pages[name] = await context.newPage();
    pages[name].setDefaultTimeout(15000);
  }
  async function login(page, name) {
    await page.getByLabel("Username", { exact: true }).fill(data[name]);
    await page.getByLabel("Password", { exact: true }).fill("Synthetic-long-password1!");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
  }
  const student = pages.student;
  await student.goto(`${origin}/login`);
  await login(student, "student");
  await student.getByRole("heading", { name: /you.re signed in/i }).waitFor();
  await student.goto(`${origin}/publish?projectId=${data.projectId}`);
  await student.getByRole("heading", { name: "Publish project" }).waitFor();
  await student.getByText("Student draft", { exact: true }).waitFor();
  await student.getByRole("checkbox", { name: data.viewer, exact: true }).check();
  await student.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  const posted = student.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/v1/projects/${data.projectId}/publications`,
  );
  await student.getByRole("button", { name: "Publish", exact: true }).click();
  const request = (await posted).postDataJSON();
  assert.equal(request.confirmedRevision, 0);
  assert.deepEqual(request.intent, {
    audience: "Authenticated",
    viewerIds: [data.viewerId],
  });
  const link = student.getByRole("link", { name: "Open publication" });
  await link.waitFor();
  const linkValue = await link.getAttribute("href");
  assert.equal(linkValue, `https://publications.example.test/p/${request.publicationId}`);
  await student.getByRole("button", { name: "Copy link" }).click();
  await student.getByRole("status").filter({ hasText: "Link copied." }).waitFor();
  const copy = await student.evaluate(() => navigator.clipboard.readText());
  assert.equal(copy, linkValue);
  const localVisitor = `${origin}${new URL(copy).pathname}`;
  const viewer = pages.viewer;
  await viewer.goto(localVisitor);
  await viewer.getByRole("heading", { name: "Exhibition unavailable" }).waitFor();
  await viewer.getByRole("link", { name: "Sign in to view exhibition" }).click();
  assert.equal(new URL(viewer.url()).searchParams.get("returnTo"), `/p/${request.publicationId}`);
  await login(viewer, "viewer");
  await viewer.waitForURL(localVisitor);
  await viewer.getByRole("heading", { name: "Student draft" }).waitFor();
  await viewer.getByRole("status").getByText("Exhibition ready").waitFor({ timeout: 30000 });
  assert.equal(await viewer.locator("canvas[aria-label='Exhibition view']").count(), 1);
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
        const token = (await (await fetch("/api/v1/auth/csrf")).json()).requestToken;
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
  const replay = await write(student, `/api/v1/projects/${data.projectId}/publications`, request);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.visitorUrl, linkValue);
  assert.equal(
    (
      await write(student, `/api/v1/projects/${data.projectId}/publications`, {
        ...request,
        intent: { audience: "Authenticated", viewerIds: [] },
      })
    ).status,
    409,
  );
  for (const audience of ["Public", "Unlisted"])
    assert.equal(
      (
        await write(student, `${snapshot}/access`, {
          audience,
          viewerIds: [],
          action: "audience",
        })
      ).status,
      204,
    );
  const anonymousFriend = pages.unrelated;
  await anonymousFriend.goto(localVisitor);
  await anonymousFriend
    .getByRole("status")
    .getByText("Exhibition ready")
    .waitFor({ timeout: 30000 });
  assert.equal((await read(anonymousFriend, assetPath)).status, 200);
  assert.equal(
    (
      await write(student, `${snapshot}/access`, {
        audience: "Authenticated",
        viewerIds: [data.viewerId],
        action: "audience",
      })
    ).status,
    204,
  );
  assert.equal((await read(student, snapshot)).status, 200);
  assert.equal((await read(viewer, `/api/v1/projects/${data.projectId}`)).status, 404);
  const asset = await read(viewer, assetPath);
  assert.equal(asset.status, 200);
  assert.equal(createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex"), data.assetHash);
  const outsider = pages.unrelated;
  await outsider.goto(localVisitor);
  await outsider.getByRole("link", { name: "Sign in to view exhibition" }).click();
  await login(outsider, "unrelated");
  await outsider.waitForURL(localVisitor);
  await outsider.getByRole("heading", { name: "Exhibition unavailable" }).waitFor();
  assert.equal((await read(outsider, snapshot)).status, 404);
  assert.equal((await read(outsider, assetPath)).status, 404);
  // Publish a second edition so revocation cannot affect the first edition's restart checks.
  await student.reload();
  await student.getByRole("heading", { name: "Publish project" }).waitFor();
  await student.getByRole("checkbox", { name: data.viewer, exact: true }).check();
  await student.getByRole("checkbox", { name: /confirm.*saved revision/i }).check();
  const secondPost = student.waitForRequest(
    (item) =>
      item.method() === "POST" &&
      new URL(item.url()).pathname === `/api/v1/projects/${data.projectId}/publications`,
  );
  await student.getByRole("button", { name: "Publish", exact: true }).click();
  const secondRequest = (await secondPost).postDataJSON();
  assert.notEqual(secondRequest.publicationId, request.publicationId);
  assert.deepEqual(secondRequest.intent, { audience: "Authenticated", viewerIds: [data.viewerId] });
  await student.getByRole("link", { name: "Open publication" }).waitFor();
  const secondLink = student.getByRole("link", { name: "Open publication" });
  const secondQr = student.getByRole("img", { name: /QR code/i });
  assert.equal(await secondLink.isVisible(), true);
  assert.equal(await secondQr.isVisible(), true);
  // Decode the rendered QR itself and compare it with the acknowledged link
  const pixels = await secondQr.evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 416;
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 416, 416);
    context.drawImage(image, 0, 0, 416, 416);
    return Array.from(context.getImageData(0, 0, 416, 416).data);
  });
  const decode = createRequire(new URL("../../web/package.json", import.meta.url))("jsqr");
  assert.equal(
    decode(new Uint8ClampedArray(pixels), 416, 416)?.data,
    await secondLink.getAttribute("href"),
  );
  const secondSnapshot = `/api/v1/publications/${secondRequest.publicationId}`;
  assert.equal(
    (await read(viewer, secondSnapshot)).status,
    200,
    "Named viewer can read the second edition before revocation",
  );

  // Students share their edition; only project managers may revoke it
  assert.equal(
    await student.getByRole("button", { name: "Revoke access", exact: true }).count(),
    0,
  );
  const manager = pages.educator;
  await manager.goto(`${origin}/login`);
  await login(manager, "educator");
  await manager.getByRole("heading", { name: /you.re signed in/i }).waitFor();
  await manager.goto(`${origin}/publish?projectId=${data.projectId}`);
  const accessSection = manager.getByRole("region", { name: "Manage publication access" });
  await accessSection
    .getByRole("textbox", { name: "Publication link or ID" })
    .fill(secondRequest.publicationId);
  await accessSection.getByRole("button", { name: "Check access" }).click();
  await accessSection.getByText("Access active", { exact: true }).waitFor();
  await accessSection.getByRole("button", { name: "Revoke access" }).click();
  const confirmation = accessSection.getByRole("group", { name: "Confirm revocation" });
  const revoked = manager.waitForResponse(
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
  await student
    .getByRole("region", { name: "Manage publication access" })
    .getByRole("button", { name: "Check access", exact: true })
    .click();
  await student.getByText("Access revoked", { exact: true }).waitFor();
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
