import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import type { Plugin, ServerOptions } from "vite";

// Private development-server settings. Never expose these through VITE_* variables.
export function accountDevelopmentServer(env: Record<string, string | undefined>): ServerOptions {
  const origin = env.SPATIA_API_ORIGIN;
  if (!origin) return {};
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    throw new Error("SPATIA_API_ORIGIN must be an HTTPS origin.");
  }
  if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("SPATIA_API_ORIGIN must be an HTTPS origin without credentials, a path, query or fragment.");
  }
  if (!env.SPATIA_DEV_TLS_CERT || !env.SPATIA_DEV_TLS_KEY) {
    throw new Error("Account integration requires SPATIA_DEV_TLS_CERT and SPATIA_DEV_TLS_KEY for browser HTTPS.");
  }
  const agent = new Agent({
    ...(env.SPATIA_API_CA ? { ca: readFileSync(env.SPATIA_API_CA) } : {}),
    rejectUnauthorized: true,
  });
  return {
    host: "127.0.0.1",
    https: { cert: readFileSync(env.SPATIA_DEV_TLS_CERT), key: readFileSync(env.SPATIA_DEV_TLS_KEY) },
    proxy: {
      "^/api(?:/|$)": {
        target: target.origin,
        changeOrigin: true,
        secure: true,
        agent,
        timeout: 15000,
        proxyTimeout: 15000,
        configure(proxy) {
          proxy.on("proxyReq", request => {
            // The API sees the TLS connection, not caller-supplied proxy assertions.
            for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"]) request.removeHeader(header);
          });
        },
      },
    },
  };
}

export function unavailableAccountApi(): Plugin {
  const middleware = (request: { url?: string }, response: { writeHead: (status: number, headers: Record<string, string>) => unknown; end: (body: string) => unknown }, next: () => void) => {
    if (!/^\/api(?:\/|\?|$)/.test(request.url ?? "")) return next();
    response.writeHead(503, { "Content-Type": "application/problem+json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ status: 503, title: "Account service unavailable", code: "api_not_configured" }));
  };
  return {
    name: "unconfigured-account-api",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
