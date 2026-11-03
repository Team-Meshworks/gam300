import assert from "node:assert/strict";
import { createServer } from "vite";
import { accountDevelopmentServer, unavailableAccountApi } from "../account-dev-server.ts";

assert.deepEqual(accountDevelopmentServer({}), {});
for (const origin of [
  "invalid",
  "http://localhost:7443",
  "https://user:secret@localhost",
  "https://localhost/api",
  "https://localhost/?token=secret",
  "https://localhost/#fragment",
]) {
  assert.throws(() => accountDevelopmentServer({ SPATIA_API_ORIGIN: origin }), /HTTPS origin/);
}
assert.throws(
  () => accountDevelopmentServer({ SPATIA_API_ORIGIN: "https://localhost:7443" }),
  /browser HTTPS/,
);
const server = await createServer({
  configFile: false,
  plugins: [unavailableAccountApi()],
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
});
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  for (const path of ["/api", "/api/auth/session", "/api?check=1"]) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).code, "api_not_configured");
  }
  const unrelated = await fetch(`http://127.0.0.1:${address.port}/apiculture`);
  assert.notEqual(unrelated.status, 503);
  console.log("Private API configuration and unavailable-service checks passed.");
} finally {
  await server.close();
}
