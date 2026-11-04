import http from "node:http";
import https from "node:https";
import net from "node:net";

// Chromium must be launched with proxy bypass '<-loopback>' so local requests
// also pass through this allowlist. Do not use routing interception: it disables
// the browser HTTP cache. This proxy leaves origin cache headers unchanged.
function parseLocal(value, protocols = ["http:", "https:"]) {
  if (typeof value !== "string" || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Expected an unambiguous loopback URL");
  }
  const match = /^([a-z]+):\/\/(\[[^\]]+\]|[^/:?#]+)(?::([0-9]+))?(?=[/?#]|$)/i.exec(value);
  if (!match || !["localhost", "127.0.0.1", "[::1]"].includes(match[2].toLowerCase())) {
    throw new Error("Only literal loopback hosts are allowed");
  }
  if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) {
    throw new Error("Invalid loopback port");
  }
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error("Only credential-free HTTP/HTTPS loopback URLs are allowed");
  }
  return url;
}

export function validateLoopbackURL(value) {
  return parseLocal(value);
}

export function normalizeLoopbackOrigin(value) {
  const url = parseLocal(value);
  // Inspect the raw suffix as URL parsing would otherwise hide dot segments.
  const suffix = value
    .slice(value.indexOf("://") + 3)
    .replace(/^(\[[^\]]+\]|[^/:?#]+)(?::[0-9]+)?/, "");
  if (suffix !== "" && suffix !== "/")
    throw new Error("Expected a loopback origin, without a path, query, or fragment");
  return url.origin;
}

function literalHost(url) {
  return url.hostname === "[::1]" ? "::1" : url.hostname;
}

function lookupLoopback(hostname, options, callback) {
  // Never ask DNS (or the hosts file) where localhost points. Let Node's
  // connection fallback try both loopback families so IPv6-only Vite servers
  // and IPv4-only fixtures remain reachable through the same approved origin.
  if (hostname !== "localhost") {
    callback(new Error("Only localhost may use loopback lookup"));
    return;
  }
  const addresses = [
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ];
  if (options.all) callback(null, addresses);
  else {
    const selected = addresses.find(({ family }) => family === options.family) || addresses[0];
    callback(null, selected.address, selected.family);
  }
}

function headersFor(req, target) {
  const headers = { ...req.headers, host: target.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  return headers;
}

export async function createLoopbackProxy(origins) {
  const allowed = new Set(origins.map(normalizeLoopbackOrigin));
  const sockets = new Set();
  let closed = false;
  const track = (socket) => {
    if (closed) socket.destroy();
    sockets.add(socket);
    // Browsers can reset speculative or denied connections during startup and
    // profile shutdown. Handle errors before parsing/denying any request, not
    // only after a CONNECT/upgrade has been accepted.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const check = (value, protocols) => {
    const target = parseLocal(value, protocols);
    const origin = target.origin.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    if (!allowed.has(origin)) throw new Error("Destination origin is not allowed");
    return target;
  };
  const requestTarget = (req, protocols) => {
    const target = check(req.url, protocols);
    if (target.hash || req.url.includes("#"))
      throw new Error("Fragments are not valid proxy request targets");
    // A single, matching Host prevents conflicting routing interpretations.
    const hosts = req.rawHeaders
      .filter((_, i) => i % 2 === 0)
      .filter((name) => name.toLowerCase() === "host");
    if (hosts.length !== 1 || req.headers.host?.toLowerCase() !== target.host.toLowerCase()) {
      throw new Error("Ambiguous request authority");
    }
    return target;
  };
  const deny = (res) => {
    res.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
    res.end("Blocked by loopback origin policy");
  };
  const denySocket = (socket) =>
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = requestTarget(req, ["http:", "https:"]);
    } catch {
      deny(res);
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: literalHost(target),
        lookup: lookupLoopback,
        autoSelectFamily: true,
        servername: target.hostname === "localhost" ? "localhost" : undefined,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: headersFor(req, target),
        agent: false,
      },
      (response) => {
        // pipe() does not forward source stream errors. A restarted fixture or
        // truncated response must close the browser response instead of hanging.
        response.on("error", () => res.destroy());
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          try {
            check(new URL(response.headers.location, target).href, ["http:", "https:"]);
          } catch {
            response.destroy();
            deny(res);
            return;
          }
        }
        res.writeHead(response.statusCode, response.rawHeaders);
        response.pipe(res);
      },
    );
    upstream.on("socket", track);
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Loopback upstream unavailable");
      } else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("clientError", (_, socket) => socket.destroy());
  server.on("connect", (req, client, head) => {
    let target;
    try {
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/i.test(req.url))
        throw new Error("Invalid CONNECT authority");
      // Chrome tunnels both HTTPS and ws:// through an HTTP proxy. CONNECT has
      // no scheme, so require its exact loopback endpoint to be approved as one
      // of those origins. Never infer another host or port from the payload.
      try {
        target = check(`https://${req.url}`, ["https:"]);
      } catch {
        target = check(`http://${req.url}`, ["http:"]);
      }
      const hostCount = req.rawHeaders
        .filter((_, i) => i % 2 === 0)
        .filter((name) => name.toLowerCase() === "host").length;
      if (hostCount !== 1 || req.headers.host?.toLowerCase() !== req.url.toLowerCase())
        throw new Error("Conflicting CONNECT Host");
    } catch {
      denySocket(client);
      return;
    }
    const upstream = track(
      net.connect({
        host: literalHost(target),
        lookup: lookupLoopback,
        autoSelectFamily: true,
        port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
      }),
    );
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.on("upgrade", (req, client, head) => {
    let target;
    try {
      target = requestTarget(req, ["http:", "ws:"]);
    } catch {
      denySocket(client);
      return;
    }
    const upstream = track(
      net.connect({
        host: literalHost(target),
        lookup: lookupLoopback,
        autoSelectFamily: true,
        port: Number(target.port || 80),
      }),
    );
    upstream.once("connect", () => {
      const headers = headersFor(req, target);
      upstream.write(
        `${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}\r\n`,
      );
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value])
          upstream.write(`${name}: ${item}\r\n`);
      }
      upstream.write("\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let closing;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    allowOrigin(origin) {
      if (closed) throw new Error("Proxy is closed");
      allowed.add(normalizeLoopbackOrigin(origin));
    },
    close() {
      if (!closing) {
        closed = true;
        closing = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const socket of sockets) socket.destroy();
      }
      return closing;
    },
  };
}
