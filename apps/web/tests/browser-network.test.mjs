import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import {
  createLoopbackProxy,
  normalizeLoopbackOrigin,
  validateLoopbackURL,
} from "./browser-network.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
function request(proxy, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      proxy,
      { path: target, headers: { host: new URL(target).host, ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
  });
}
async function handshake(proxy, message) {
  const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(proxy).port) });
  await once(socket, "connect");
  socket.write(message);
  const [data] = await once(socket, "data");
  return { socket, text: data.toString() };
}

test("strict loopback URL and origin validation", () => {
  for (const origin of ["http://localhost:123", "https://127.0.0.1", "http://[::1]:42"]) {
    assert.equal(normalizeLoopbackOrigin(origin), origin);
    assert.equal(validateLoopbackURL(`${origin}/some/path?q=1`).origin, origin);
  }
  for (const bad of [
    "https://example.com",
    "file:///tmp/a",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://127.0.0.2",
    "http://localhost.example",
    "http://user:pass@localhost",
    "http://localhost@evil.test",
    "http://localhost\\@evil.test",
    "http://localhost:0",
    "http://localhost:65536",
    "http://localhost\n",
    "http://%6cocalhost",
    "http://[::ffff:127.0.0.1]",
    "ws://localhost",
  ])
    assert.throws(() => validateLoopbackURL(bad), bad);
  for (const suffix of ["/path", "/..", "/?x", "/#x", "?", "#"]) {
    assert.throws(() => normalizeLoopbackOrigin(`http://localhost${suffix}`));
  }
});

test("HTTP allowlist preserves cache headers and blocks unrelated origins and redirects", async (t) => {
  let visits = 0;
  const originServer = http.createServer((req, res) => {
    visits++;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "https://example.invalid/no-network" });
      res.end();
      return;
    }
    if (req.url === "/local-redirect") {
      res.writeHead(302, { Location: "/cached" });
      res.end();
      return;
    }
    if (req.headers["if-none-match"] === '"unchanged"') {
      res.writeHead(304, { ETag: '"unchanged"' });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Cache-Control": "public, max-age=600",
      ETag: '"unchanged"',
      Vary: "Accept-Encoding",
    });
    res.end("cached response");
  });
  const origin = await listen(originServer);
  t.after(() => new Promise((resolve) => originServer.close(resolve)));
  const unrelated = http.createServer(() => {
    throw new Error("Disallowed server must never be contacted");
  });
  const unrelatedOrigin = await listen(unrelated);
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const proxy = await createLoopbackProxy([origin]);
  t.after(() => proxy.close());
  const response = await request(proxy.url, `${origin}/cached`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=600");
  assert.equal(response.headers.etag, '"unchanged"');
  assert.equal(response.headers.vary, "Accept-Encoding");
  assert.equal(response.body, "cached response");
  assert.equal(
    (await request(proxy.url, `${origin}/cached`, { "if-none-match": '"unchanged"' })).status,
    304,
  );
  assert.equal((await request(proxy.url, `${origin}/local-redirect`)).status, 302);
  assert.equal((await request(proxy.url, `${origin}/redirect`)).status, 403);
  assert.equal((await request(proxy.url, unrelatedOrigin)).status, 403);
  assert.equal((await request(proxy.url, "http://example.invalid/")).status, 403);
  assert.equal((await request(proxy.url, origin, { host: "localhost:1234" })).status, 403);
  assert.equal(visits, 4);
});

test("localhost is connected using a loopback literal and dynamic origins remain validated", async (t) => {
  const originServer = http.createServer((_, res) => res.end("local"));
  const origin = await listen(originServer);
  t.after(() => new Promise((resolve) => originServer.close(resolve)));
  const proxy = await createLoopbackProxy([]);
  t.after(() => proxy.close());
  const localhost = origin.replace("127.0.0.1", "localhost");
  assert.equal((await request(proxy.url, localhost)).status, 403);
  assert.throws(() => proxy.allowOrigin("https://example.invalid"));
  assert.throws(() => proxy.allowOrigin(`${localhost}/not-an-origin`));
  proxy.allowOrigin(localhost);
  assert.equal((await request(proxy.url, localhost)).body, "local");
  assert.equal((await request(proxy.url, origin)).status, 403);
});

test("CONNECT enforces exact approved endpoints for HTTPS and WebSockets", async (t) => {
  let connections = 0;
  const upstreamSockets = new Set();
  const upstream = net.createServer((socket) => {
    connections++;
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    socket.on("data", (data) => socket.write(data));
  });
  const httpOrigin = await listen(upstream);
  t.after(() => {
    for (const socket of upstreamSockets) socket.destroy();
    return new Promise((resolve) => upstream.close(resolve));
  });
  const proxy = await createLoopbackProxy([]);
  t.after(() => proxy.close());
  const authority = new URL(httpOrigin).host;
  const connect = (host) => `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`;
  for (const host of [authority, "example.invalid:443", "localhost:1", `${authority}/bad`]) {
    const denied = await handshake(proxy.url, connect(host));
    assert.match(denied.text, /403 Forbidden/);
    denied.socket.destroy();
  }
  assert.equal(connections, 0);
  proxy.allowOrigin(httpOrigin);
  const webSocketTunnel = await handshake(proxy.url, connect(authority));
  assert.match(webSocketTunnel.text, /200 Connection Established/);
  webSocketTunnel.socket.destroy();
  const tlsProxy = await createLoopbackProxy([httpOrigin.replace("http:", "https:")]);
  t.after(() => tlsProxy.close());
  const tlsTunnel = await handshake(tlsProxy.url, connect(authority));
  assert.match(tlsTunnel.text, /200 Connection Established/);
  tlsTunnel.socket.destroy();
  const accepted = await handshake(proxy.url, connect(authority));
  assert.match(accepted.text, /200 Connection Established/);
  const echoed = once(accepted.socket, "data");
  accepted.socket.write("opaque TLS payload");
  assert.equal((await echoed)[0].toString(), "opaque TLS payload");
  const closed = once(accepted.socket, "close");
  await proxy.close();
  await closed;
  await proxy.close();
  assert.throws(() => proxy.allowOrigin(httpOrigin));
});

test("WebSocket upgrades enforce exact local origins and clean up open sockets", async (t) => {
  let upgrades = 0;
  const originServer = http.createServer();
  const upgradedSockets = new Set();
  originServer.on("upgrade", (_, socket) => {
    upgrades++;
    upgradedSockets.add(socket);
    socket.on("close", () => upgradedSockets.delete(socket));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    socket.on("data", (data) => socket.write(data));
  });
  const origin = await listen(originServer);
  t.after(() => {
    for (const socket of upgradedSockets) socket.destroy();
    return new Promise((resolve) => originServer.close(resolve));
  });
  const proxy = await createLoopbackProxy([origin]);
  t.after(() => proxy.close());
  const upgrade = (url) =>
    `GET ${url}/socket HTTP/1.1\r\nHost: ${new URL(url).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`;
  for (const url of ["ws://example.invalid", origin.replace("127.0.0.1", "localhost")]) {
    const denied = await handshake(proxy.url, upgrade(url));
    assert.match(denied.text, /403 Forbidden/);
    denied.socket.destroy();
  }
  const accepted = await handshake(proxy.url, upgrade(origin.replace("http:", "ws:")));
  assert.match(accepted.text, /101 Switching Protocols/);
  assert.equal(upgrades, 1);
  const closed = once(accepted.socket, "close");
  await proxy.close();
  await closed;
});
