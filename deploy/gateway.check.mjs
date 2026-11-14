import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = "team32.dp-ext8.com";
const ip = "51.79.242.181";
const config = JSON.parse(
  execFileSync(
    process.env.CADDY_BINARY ?? "caddy",
    [
      "adapt",
      "--config",
      fileURLToPath(new URL("./gateway.Caddyfile", import.meta.url)),
      "--adapter",
      "caddyfile",
    ],
    { encoding: "utf8", env: { ...process.env, SITE_HOST: host, SITE_IP: ip } },
  ),
);
const servers = Object.values(config.apps.http.servers);
function route(port, hostname) {
  const server = servers.find((entry) => entry.listen.includes(`:${port}`));
  const result = server?.routes.find((entry) =>
    entry.match?.some((match) => match.host?.includes(hostname)),
  );
  assert.ok(result, `Missing ${hostname}:${port} route`);
  return result;
}
function handlers(value) {
  if (!value || typeof value !== "object") return [];
  return [...(value.handler ? [value] : []), ...Object.values(value).flatMap(handlers)];
}
for (const [hostname, port, upstream] of [
  [host, 443, 8081],
  [host, 8443, 8082],
  [ip, 443, 8081],
  [ip, 8443, 8082],
  [ip, 9443, 8083],
]) {
  const entries = handlers(route(port, hostname));
  assert.ok(
    entries.some((entry) => entry.handler === "reverse_proxy"),
    "Route must actually proxy the application",
  );
  for (const proxy of entries.filter((entry) => entry.handler === "reverse_proxy")) {
    assert.deepEqual(proxy.upstreams, [{ dial: `127.0.0.1:${upstream}` }]);
  }
  if (port !== 9443)
    assert.ok(
      !entries.some((entry) => entry.handler === "authentication"),
      "Application routes must not add a Basic auth gate",
    );
}
const redirect = handlers(route(80, host)).find((entry) => entry.handler === "static_response");
assert.deepEqual(redirect?.headers.Location, [`https://${host}{http.request.uri}`]);
assert.ok([301, 308].includes(redirect.status_code));
const policies = config.apps.tls.automation.policies;
const domainPolicy = policies.find((entry) => entry.subjects?.includes(host));
assert.equal(domainPolicy?.issuers[0]?.ca, "https://acme-v02.api.letsencrypt.org/directory");
assert.equal(
  domainPolicy.issuers[0].profile,
  undefined,
  "Domain certificates use the standard profile",
);
const ipPolicy = policies.find((entry) => entry.subjects?.includes(ip));
assert.equal(ipPolicy?.issuers[0]?.profile, "shortlived", "Keep existing IP certificate renewal");
console.log(
  "Gateway domain routing, Let's Encrypt policies, legacy routes and outer auth checks passed",
);
