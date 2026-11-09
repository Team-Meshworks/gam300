import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const binary = process.env.CADDY_BINARY ?? "caddy";
const temporary = await mkdtemp(join(tmpdir(), "spatia-proxy-"));
const processes = [];
const backend = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      address: request.headers["x-forwarded-for"],
      scheme: request.headers["x-forwarded-proto"],
    }),
  );
});
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function get(port, source, headers = {}, tls = true, path = "/api/v1/probe") {
  return new Promise((resolve, reject) => {
    const request = (tls ? httpsRequest : httpRequest)(
      {
        hostname: "127.0.0.1",
        port,
        path,
        localAddress: source,
        rejectUnauthorized: false,
        headers: { host: `localhost:${port}`, ...headers },
        timeout: 3000,
      },
      (response) => {
        let body = "";
        response
          .setEncoding("utf8")
          .on("data", (chunk) => (body += chunk))
          .on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request
      .on("error", reject)
      .on("timeout", () =>
        request.destroy(new Error("Proxy request timed out")),
      );
    request.end();
  });
}
async function start(name, config) {
  const path = join(temporary, name + ".Caddyfile");
  await writeFile(path, config);
  const child = spawn(
    binary,
    ["run", "--config", path, "--adapter", "caddyfile"],
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
  processes.push(child);
  let logs = "";
  child.stderr.on("data", (data) => (logs += data));
  child.on("error", (error) => (logs += error.message));
  return () => {
    if (child.exitCode !== null) throw new Error(name + " exited: " + logs);
  };
}
try {
  const fallbackPort = await listen(backend);
  const target = process.env.SPATIA_PROXY_TEST_API_PORT ?? fallbackPort;
  const inner = await freePort(),
    localTls = await freePort(),
    outer = await freePort();
  let config = await readFile(
    new URL("./server.Caddyfile", import.meta.url),
    "utf8",
  );
  config = config
    .replace("admin off", "admin off\n\tskip_install_trust")
    .replaceAll("api:8080", `127.0.0.1:${target}`)
    .replaceAll("web:8080", `127.0.0.1:${target}`)
    .replaceAll(":8080", `:${inner}`)
    .replaceAll("localhost:8443", `localhost:${localTls}`);
  const checkInner = await start("inner", config);
  const checkOuter = await start(
    "outer",
    `{
    admin off
    persist_config off
    skip_install_trust
    auto_https disable_redirects
  }
  https://localhost:${outer} {
    tls internal
    reverse_proxy 127.0.0.1:${inner}
  }`,
  );
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    checkInner();
    checkOuter();
    try {
      if ((await get(outer, "127.0.0.2")).status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for local proxy startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Both proxies must start and reach the backend");
  for (const source of ["127.0.0.2", "127.0.0.3"]) {
    const response = await get(outer, source, {
      "X-Forwarded-For": "198.51.100.10, 203.0.113.20",
      "X-Forwarded-Proto": "http",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      JSON.parse(response.body),
      { address: source, scheme: "https" },
      "Each real client must arrive as exactly one verified address, regardless of forged headers",
    );
  }
  for (const source of ["127.0.0.1", "127.0.0.2"]) {
    const direct = await get(localTls, source, {
      "X-Forwarded-For": "198.51.100.10",
    });
    assert.deepEqual(
      JSON.parse(direct.body),
      { address: source, scheme: "https" },
      "Local HTTPS must not trust forwarding headers, even from the host peer",
    );
  }
  const untrusted = await get(
    inner,
    "127.0.0.3",
    { "X-Forwarded-For": "198.51.100.10", "X-Forwarded-Proto": "https" },
    false,
  );
  assert.equal(
    untrusted.status,
    400,
    "Untrusted peers cannot use the host gateway's HTTP ingress",
  );
  if (process.env.SPATIA_PROXY_TEST_API_PORT) {
    for (let count = 0; count < 60; count++) {
      assert.equal(
        (await get(outer, "127.0.0.2", {}, true, "/api/v1/rate")).status,
        204,
      );
    }
    assert.equal(
      (
        await get(
          outer,
          "127.0.0.2",
          { "X-Forwarded-For": "203.0.113.99" },
          true,
          "/api/v1/rate",
        )
      ).status,
      429,
      "Forged addresses cannot bypass the API login limit",
    );
    assert.equal(
      (await get(outer, "127.0.0.3", {}, true, "/api/v1/rate")).status,
      204,
      "A second client must retain its separate API login budget",
    );
  }
  console.log(
    "PASS: pinned Caddy two-hop client identity, forged headers, local HTTPS and untrusted ingress",
  );
} finally {
  for (const child of processes) {
    if (child.exitCode === null && child.pid) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
  await new Promise((resolve) => backend.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
