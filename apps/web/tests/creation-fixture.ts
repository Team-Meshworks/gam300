import { onTestFinished } from "vitest";
import { serveHttp } from "./http-fixture";
import {
  loadCreationHead,
  type CreationHead,
  type CreationPurpose,
} from "../editor/home/create-operation";
import { createWorkspaceClient } from "../editor/home/workspace-api";

export const creatorId = "11111111-1111-4111-8111-111111111111";
export const organizationId = "22222222-2222-4222-8222-222222222222";

export const readyHead: CreationHead = { state: "ready", operationId: null, receipt: null };

export function profileStorage() {
  const prefix = crypto.randomUUID() + ":";
  onTestFinished(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  });
  return {
    getItem: (key: string) => sessionStorage.getItem(prefix + key),
    setItem: (key: string, value: string) => sessionStorage.setItem(prefix + key, value),
    removeItem: (key: string) => sessionStorage.removeItem(prefix + key),
  };
}

export function fillStorage() {
  const key = crypto.randomUUID();
  const free = () => sessionStorage.removeItem(key);
  onTestFinished(free);
  let lower = 0;
  let upper = 10 * 1024 * 1024;
  while (upper - lower > 1) {
    const middle = Math.floor((upper + lower) / 2);
    try {
      sessionStorage.setItem(key, "a".repeat(middle));
      lower = middle;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
      upper = middle;
    }
  }
  return free;
}

export async function serveCreation(
  options: {
    actorId?: string;
    head?: () => Response;
    write?: (path: string, body: object) => Response | Promise<Response>;
    read?: (path: string) => Response;
  } = {},
) {
  const actorId = options.actorId ?? creatorId;
  const writes: { path: string; actorId: string; method: string; body: object }[] = [];
  const server = await serveHttp(async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET") {
      if (pathname === "/api/v1/auth/session")
        return Response.json({
          userId: actorId,
          displayName: "Teacher",
          role: "Educator",
          orgId: organizationId,
          mustChangePassword: false,
        });
      if (pathname === "/api/v1/auth/csrf") return Response.json({ requestToken: "token" });
      if (pathname.startsWith("/api/v1/creation-operations/"))
        return options.head?.() ?? Response.json(readyHead);
      if (options.read) return options.read(pathname + url.search);
    }
    if (
      request.method === "POST" &&
      request.headers.get("X-Spatia-Account") === actorId &&
      request.headers.get("X-CSRF-TOKEN") === "token"
    ) {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object") throw new Error("Expected a creation request body");
      writes.push({ path: pathname, actorId, method: request.method, body });
      if (options.write) return options.write(pathname, body);
    }
    throw new Error(`Unexpected ${request.method} ${request.url}`);
  });
  return {
    ...server,
    writes,
    write: createWorkspaceClient(server.fetch).write,
    read: (who: string, purpose: CreationPurpose) => loadCreationHead(who, purpose, server.fetch),
  };
}
