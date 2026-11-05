import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { launchBrowser } from "../../web/tests/browser-security.mjs";

const target = new URL(process.argv[2]);
assert.equal(target.protocol, "https:");
assert.equal(target.hostname, "127.0.0.1");
const origin = target.origin;
const data = JSON.parse(process.argv[3]);
const browser = await launchBrowser({
  target: origin,
  verificationOutput: "stdout",
});
console.log(`Node ${process.version}; Chromium ${browser.version()}`);
try {
  const pages = {};
  for (const name of ["educator", "viewer", "unrelated"]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    pages[name] = await context.newPage();
    await pages[name].goto(origin + "/_test/browser");
    const login = await write(name, "/api/auth/login", {
      userName: data[name],
      password: "Synthetic-long-password1!",
    });
    assert.equal(login.status, 204, `${name} login`);
  }
  async function write(name, path, body) {
    return pages[name].evaluate(
      async ({ path, body }) => {
        const token = (await (await fetch("/api/auth/csrf")).json())
          .requestToken;
        const response = await fetch(path, {
          method: "POST",
          redirect: "error",
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
      { path, body },
    );
  }
  async function read(name, path) {
    return pages[name].evaluate(async (path) => {
      const response = await fetch(path, { redirect: "error" });
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, path);
  }
  const publishPath = `/api/projects/${data.projectId}/publications`;
  const snapshotPath = `/api/publications/${data.publicationId}`;
  const assetPath = `${snapshotPath}/assets/${data.assetId}/bytes`;
  const request = {
    publicationId: data.publicationId,
    confirmedRevision: 0,
    intent: { audience: "Authenticated", viewerIds: [data.viewerId] },
  };
  const created = await write("educator", publishPath, request);
  assert.equal(created.status, 201);
  assert.equal(created.body.publicationId, data.publicationId);
  assert.equal(created.body.sourceRevision, 0);
  assert.equal(
    created.body.snapshotUrl,
    `https://publications.example.test${snapshotPath}`,
  );
  for (const audience of ["Public", "Unlisted"]) {
    const promotion = await write("educator", `${snapshotPath}/access`, {
      audience,
      viewerIds: [],
      action: "audience",
    });
    assert.equal(promotion.status, 503);
  }
  for (const name of ["educator", "viewer"]) {
    assert.equal((await read(name, snapshotPath)).status, 200);
    const asset = await read(name, assetPath);
    assert.equal(asset.status, 200);
    assert.equal(
      createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex"),
      data.assetHash,
    );
  }
  assert.equal(
    (await read("viewer", `/api/projects/${data.projectId}`)).status,
    404,
  );
  assert.equal((await read("unrelated", snapshotPath)).status, 404);
  assert.equal((await read("unrelated", assetPath)).status, 404);
  const replay = await write("educator", publishPath, request);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  const changed = await write("educator", publishPath, {
    ...request,
    intent: { audience: "Authenticated", viewerIds: [] },
  });
  assert.equal(changed.status, 409);
  console.log(
    "browser publication API passed: committed edition, protected reads and retry identity",
  );
} finally {
  await browser.close();
}
