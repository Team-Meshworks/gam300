import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const built = resolve(process.argv[2] ?? join(root, "apps/web/dist/editor"));
const restricted = resolve(process.argv[3] ?? join(built, "restricted-assets"));
const temporary = await mkdtemp(join(tmpdir(), "spatia-catalogue-"));
const children = [];
let browserSession = false;
const sessionHeaders = { Cookie: "spatia-test=session" };
let authStatus = 204;
let authReads = 0;
const sessionChallenge = 'SpatiaSession realm="Spatia", login_uri="/api/v1/auth/login"';
const organizationPath = "/api/v1/admin/organizations/22222222-2222-4222-8222-222222222222";
const selectedProject = "33333333-3333-4333-8333-333333333333";
const resolutionPath = `/api/v1/projects/legacy-resolution?useExisting=${selectedProject}`;
let receivedWrite;
const api = createServer(async (request, response) => {
  if ([organizationPath, organizationPath + "/deletion", resolutionPath].includes(request.url)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receivedWrite = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    if (request.url === resolutionPath) {
      response.writeHead(200, {
        "X-Spatia-Creation-Resolution": "existing",
        Location: `/api/v1/projects/${selectedProject}`,
      }).end();
    } else {
      response.writeHead(204).end();
    }
    return;
  }
  if (request.url === "/api/v1/auth/session" && browserSession) {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        userId: "11111111-1111-4111-8111-111111111111",
        displayName: "Packaged browser fixture",
        role: "Creator",
        orgId: "22222222-2222-4222-8222-222222222222",
        mustChangePassword: false,
      }),
    );
    return;
  }
  if (request.url === "/api/v1/auth/asset-access") {
    authReads++;
    assert.equal(request.method, "GET");
    assert.equal(request.headers["x-forwarded-proto"], "https");
    const authorized =
      browserSession || request.headers.cookie === sessionHeaders.Cookie;
    const status = authorized ? authStatus : 401;
    response.writeHead(status, {
      "Cache-Control": "no-store",
      ...(status === 401 ? { "WWW-Authenticate": sessionChallenge } : {}),
    });
  } else response.writeHead(401);
  response.end();
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}
async function start(name, config) {
  const path = join(temporary, `${name}.Caddyfile`);
  await writeFile(path, config);
  const child = spawn(
    process.env.CADDY_BINARY ?? "caddy",
    ["run", "--config", path],
    {
      windowsHide: true,
      env: {
        ...process.env,
        SPATIA_OUTER_PROXY_IP: "127.0.0.1/32",
        XDG_DATA_HOME: join(temporary, name),
        XDG_CONFIG_HOME: join(temporary, name),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  children.push(child);
  let logs = "";
  child.stderr.on("data", (data) => (logs += data));
  child.on("error", (error) => (logs += error.message));
  return () => assert.equal(child.exitCode, null, logs);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quotePath = (path) => JSON.stringify(path.replaceAll("\\", "/"));
try {
  // Match the Docker image's separation of /srv and /srv-restricted. CI supplies
  // directories copied from the actual image; local checks can use a Vite build.
  const publicRoot = join(temporary, "public");
  await cp(built, publicRoot, {
    recursive: true,
    filter: (path) => resolve(path) !== restricted,
  });
  const files = await readdir(restricted);
  assert.ok(files.length > 0, "The check must exercise actual bundled assets");
  const hashes = new Set(files.map((name) => name.split(".")[0]));
  const manifest = JSON.parse(
    await readFile(join(root, "assets/manifest.json"), "utf8"),
  );
  for (const asset of manifest.assets.filter(
    (asset) =>
      asset.assetId.startsWith("room-") ||
      asset.assetId === "library-untitled-v1",
  )) {
    assert.ok(
      hashes.has(asset.sha256),
      `${asset.assetId} must be included in the protected check`,
    );
  }
  for (const file of await readdir(publicRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (file.isFile()) {
      const bytes = await readFile(join(file.parentPath, file.name));
      assert.ok(
        !hashes.has(hash(bytes)),
        `Restricted bytes copied to public file ${file.name}`,
      );
    }
  }
  const publicPort = await freePort();
  const privatePort = await freePort();
  const inner = await freePort();
  const tls = await freePort();
  const outer = await freePort();
  const outerTls = await freePort();
  const apiPort = await listen(api);
  const web = (
    await readFile(new URL("./app.Caddyfile", import.meta.url), "utf8")
  )
    .replace("root * /srv-restricted", `root * ${quotePath(restricted)}`)
    .replace("root * /srv", `root * ${quotePath(publicRoot)}`)
    .replace(":8080 {", `http://127.0.0.1:${publicPort} {`)
    .replace(":8081 {", `http://127.0.0.1:${privatePort} {`);
  const checkWeb = await start("web", web);
  const storage = join(temporary, "gateway-storage");
  const hostGateway = await readFile(new URL("./gateway.Caddyfile", import.meta.url), "utf8");
  const hostRoutes = hostGateway.match(/^\(application\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(hostRoutes, "Expected the host gateway's application routes");
  const devGate = (await readFile(new URL("./dev-creates.caddy", import.meta.url), "utf8"))
    .replaceAll("root /config", `root ${quotePath(temporary)}`);
  const server = (
    await readFile(new URL("./server.Caddyfile", import.meta.url), "utf8")
  )
    .replace("admin off", `admin off\n\tskip_install_trust\n\tstorage file_system {\n\t\troot ${quotePath(storage)}\n\t}`)
    .replaceAll("api:8080", `127.0.0.1:${apiPort}`)
    .replaceAll("web:8080", `127.0.0.1:${publicPort}`)
    .replaceAll("web:8081", `127.0.0.1:${privatePort}`)
    .replaceAll(":8080", `:${inner}`)
    .replaceAll("localhost:8443", `localhost:${tls}`);
  const checkServer = await start(
    "gateway",
    `${server}
${hostRoutes.replace("(application)", "(host_application)")}
https://localhost:${outerTls} {
  tls internal
  import host_application 127.0.0.1:${inner}
}
http://127.0.0.1:${outer} {
  ${devGate}
  reverse_proxy 127.0.0.1:${inner} {
    header_up X-Forwarded-Proto https
  }
}
`,
  );
  const origin = `http://127.0.0.1:${outer}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    checkWeb();
    checkServer();
    try {
      if ((await fetch(`${origin}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the loopback listeners. */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, "Caddy must start with the deployment configuration");
  const pauseFile = join(temporary, "spatia-dev-creates-paused");
  await writeFile(pauseFile, "");
  for (const [method, path] of [
    ["POST", "/api/v1/projects"],
    ["POST", "/API/V1/classes/"],
    ["POST", `/api/v1/projects/${selectedProject}/duplicate`],
    ["PUT", resolutionPath],
  ]) {
    const response = await fetch(origin + path, { method, headers: sessionHeaders });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("retry-after"), "120");
  }
  assert.equal(
    (await fetch(`${origin}/api/v1/projects/legacy-resolution`, { method: "PUT" })).status,
    401,
  );
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  await rm(pauseFile);
  assert.equal((await fetch(`${origin}/api/v1/projects`, { method: "POST" })).status, 401);
  console.log("PASS: development creates return 503 during the pause and reach the API after reopening.");
  const confirmation = JSON.stringify({ confirmationName: "Synthetic école" });
  const ca = await readFile(join(storage, "pki/authorities/local/root.crt"));
  for (const [method, path, body] of [
    ["POST", organizationPath + "/deletion", confirmation],
    ["DELETE", organizationPath, confirmation],
    ["PUT", resolutionPath, JSON.stringify({ title: "Galerie de l'école" })],
  ]) {
    receivedWrite = undefined;
    const reply = await new Promise((resolveReply, reject) => {
      const request = httpsRequest(
        `https://localhost:${outerTls}${path}`,
        {
          ca,
          family: 4,
          method,
          headers: {
            ...sessionHeaders,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "X-CSRF-TOKEN": "synthetic-token",
            "X-Spatia-Account": "11111111-1111-4111-8111-111111111111",
          },
        },
        (response) => {
          response.resume();
          resolveReply(response);
        },
      );
      request.on("error", reject);
      request.end(body);
    });
    if (path === resolutionPath) {
      assert.equal(reply.statusCode, 200);
      assert.equal(reply.headers["x-spatia-creation-resolution"], "existing");
      assert.equal(reply.headers.location, `/api/v1/projects/${selectedProject}`);
    } else {
      assert.equal(reply.statusCode, 204);
    }
    assert.equal(receivedWrite?.method, method);
    assert.equal(receivedWrite.path, path);
    assert.equal(receivedWrite.body, body);
    assert.equal(receivedWrite.headers.cookie, sessionHeaders.Cookie);
    assert.equal(receivedWrite.headers["x-csrf-token"], "synthetic-token");
    assert.equal(
      receivedWrite.headers["x-spatia-account"],
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(receivedWrite.headers["x-forwarded-proto"], "https");
  }
  assert.equal((await fetch(`${origin}/login`)).status, 200);
  for (const file of files) {
    const path = `/restricted-assets/${file}`;
    const denied = await fetch(origin + path);
    assert.equal(denied.status, 401, file);
    assert.equal((await denied.arrayBuffer()).byteLength, 0);
    assert.match(denied.headers.get("cache-control"), /no-store/);
    assert.equal(denied.headers.get("www-authenticate"), sessionChallenge);
    assert.equal(
      (await fetch(`http://127.0.0.1:${publicPort}${path}`)).status,
      404,
    );
    assert.equal((await fetch(`${origin}/assets/${file}`)).status, 404);
  }
  const model = files.find((name) => name.endsWith(".glb"));
  assert.ok(model);
  const url = `${origin}/restricted-assets/${model}`;
  const before = authReads;
  const allowed = await fetch(url, { headers: sessionHeaders });
  assert.equal(allowed.status, 200);
  assert.equal(
    hash(Buffer.from(await allowed.arrayBuffer())),
    basename(model, ".glb"),
  );
  assert.match(allowed.headers.get("cache-control"), /private, no-store/);
  const ranged = await fetch(url, {
    headers: { ...sessionHeaders, Range: "bytes=0-3" },
  });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "glTF");
  assert.match(ranged.headers.get("cache-control"), /no-store/);
  assert.equal(
    (await fetch(url, { method: "HEAD", headers: sessionHeaders })).status,
    200,
  );
  assert.equal(
    authReads - before,
    3,
    "GET, HEAD and range requests each check the session",
  );
  assert.equal(
    (await fetch(url)).status,
    401,
    "A previous authorized read must not admit anonymous readers",
  );
  for (const status of [401, 403, 503]) {
    authStatus = status;
    for (const init of [
      {},
      { method: "HEAD" },
      { headers: { Range: "bytes=0-3" } },
    ]) {
      const denied = await fetch(url, {
        ...init,
        headers: { ...sessionHeaders, ...init.headers },
      });
      assert.equal(denied.status, status);
      assert.equal((await denied.arrayBuffer()).byteLength, 0);
      assert.match(denied.headers.get("cache-control"), /no-store/);
    }
  }
  console.log(
    `PASS: ${files.length} restricted files denied anonymously; no public copies; authenticated bytes, ranges, revocation, outages and no-store headers checked in Caddy.`,
  );
  if (process.argv.includes("--browser")) {
    // Give the existing authoring smoke tests a full synthetic account at the
    // auth upstream. Anonymous denial was verified above, before this fixture.
    browserSession = true;
    authStatus = 204;
    for (const test of [
      "deployment",
      "workspace-routes",
      "admin-dashboard",
      "editor-build",
      "editor-session-loading",
    ]) {
      const child = spawn(
        process.execPath,
        [`tests/${test}.check.mjs`, origin],
        {
          cwd: join(root, "apps/web"),
          stdio: "inherit",
          windowsHide: true,
        },
      );
      const [code] = await once(child, "exit");
      assert.equal(code, 0, `${test} browser check failed`);
    }
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
  await new Promise((done) => api.close(done));
  await rm(temporary, { recursive: true, force: true });
}
