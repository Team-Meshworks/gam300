import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { launchBrowser, launchPersistentBrowser } from "./browser-security.mjs";

let forbiddenHits = 0;
let cachedHits = 0;
const forbidden = createServer((_req, res) => {
  forbiddenHits++;
  res.end("forbidden");
});
forbidden.on("upgrade", (_req, socket) => {
  forbiddenHits++;
  socket.destroy();
});
forbidden.listen(0, "127.0.0.1");
await once(forbidden, "listening");
const offOrigin = `http://127.0.0.1:${forbidden.address().port}`;
const server = createServer((req, res) => {
  if (req.url === "/cached") {
    cachedHits++;
    res.writeHead(200, { "Cache-Control": "public, max-age=3600", "Content-Type": "text/plain" });
    res.end("cache-preserved");
  } else if (req.url === "/redirect") {
    res.writeHead(302, { Location: offOrigin });
    res.end();
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Local security fixture</title>");
  }
});
const upgradedSockets = new Set();
server.on("upgrade", (req, socket) => {
  upgradedSockets.add(socket);
  socket.once("close", () => upgradedSockets.delete(socket));
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.once("data", () => socket.end());
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const target = `http://127.0.0.1:${server.address().port}`;
let browser;
let persistent;
try {
  browser = await launchBrowser({ target });
  const page = await browser.newPage();
  await page.goto(target);
  assert.equal(await page.evaluate(async () => (await fetch("/cached")).text()), "cache-preserved");
  assert.equal(await page.evaluate(async () => (await fetch("/cached")).text()), "cache-preserved");
  assert.equal(cachedHits, 1, "Proxy policy must preserve real HTTP cache hits");
  assert.equal(
    await page.evaluate(
      (origin) =>
        new Promise((resolve) => {
          const socket = new WebSocket(origin.replace("http:", "ws:") + "/socket");
          const timer = setTimeout(() => {
            socket.close();
            resolve(false);
          }, 5000);
          socket.onerror = () => {
            clearTimeout(timer);
            resolve(false);
          };
          socket.onopen = () => {
            clearTimeout(timer);
            socket.close();
            resolve(true);
          };
        }),
      target,
    ),
    true,
    "Same-origin WebSockets must work through Chrome's CONNECT proxy tunnel",
  );
  const blocked = await page.evaluate(async (origin) => {
    const request = async (url) => {
      try {
        const response = await fetch(url);
        return response.status === 403;
      } catch {
        return true;
      }
    };
    return [await request(origin), await request("/redirect")];
  }, offOrigin);
  assert.deepEqual(blocked, [true, true]);
  await page.evaluate(
    (origin) =>
      new Promise((resolve) => {
        const socket = new WebSocket(origin.replace("http:", "ws:"));
        socket.onerror = () => resolve();
        socket.onopen = () => {
          socket.close();
          resolve();
        };
      }),
    offOrigin,
  );
  const popup = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((origin) => {
      window.open(origin);
    }, offOrigin),
  ]).then(([popup]) => popup);
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup.close();
  assert.equal(
    forbiddenHits,
    0,
    "Off-origin requests, redirects, WebSockets and popups never reach a server",
  );
  persistent = await launchPersistentBrowser({ target });
  const persistentPage = await persistent.newPage();
  await persistentPage.goto(target);
  assert.equal(await persistentPage.title(), "Local security fixture");
  console.log(
    "PASS: sandboxed regular/persistent browsers, loopback network isolation and real HTTP cache",
  );
} finally {
  await persistent?.close();
  await browser?.close();
  for (const socket of upgradedSockets) socket.destroy();
  server.closeAllConnections();
  forbidden.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => forbidden.close(resolve)),
  ]);
}
