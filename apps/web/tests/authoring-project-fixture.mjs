import { EventEmitter, on } from "node:events";
import { readFileSync } from "node:fs";
import { json } from "node:stream/consumers";

const fixture = JSON.parse(
  readFileSync(new URL("../shared/project/fixtures/m2-project.json", import.meta.url), "utf8"),
);
export const blankProject = {
  ...fixture,
  title: "Untitled",
  scenes: [
    {
      ...fixture.scenes[0],
      name: "Scene 1",
      environmentAssetId: null,
      objects: [],
      groups: [],
      zones: [],
      viewpoints: [],
      rules: [],
      hotspots: [],
      interactions: [],
    },
  ],
};

export function createProjectFixture(initial = blankProject) {
  let document = structuredClone(initial);
  let revision = 1;
  const saves = new EventEmitter();
  const projectPath = `/api/v1/projects/${initial.projectId}`;
  function setDocument(next) {
    document = structuredClone(next);
    revision++;
    saves.emit("saved", document);
  }
  async function respond(path, method, token, readBody) {
    const reply = (status, json) => ({ status, json });
    if (path === "/api/v1/auth/session")
      return reply(200, {
        userId: "00000000-0000-4000-8000-000000000001",
        orgId: "00000000-0000-4000-8000-000000000002",
        displayName: "Browser test",
        role: "Creator",
        mustChangePassword: false,
        developmentAssetsAllowed: true,
      });
    if (path === "/api/v1/auth/csrf") return reply(200, { requestToken: "test-token" });
    if (path === "/api/v1/creation-operations/import" && method === "GET")
      return reply(200, { state: "ready", operationId: null, receipt: null });
    if (path === "/api/v1/assets") return reply(200, []);
    if (path === `${projectPath}/assets`) return reply(200, []);
    if (path === `${projectPath}/publication-readiness`)
      return reply(200, {
        projectId: initial.projectId,
        revision,
        state: "Ready",
        approved: null,
        completionConfirmed: null,
      });
    if (path === projectPath) {
      if (method === "GET")
        return reply(200, {
          projectId: initial.projectId,
          revision,
          document,
          permissions: { canEdit: true },
        });
      const body = await readBody();
      if (body.expectedRevision !== revision || token !== "test-token") return reply(409, {});
      setDocument(body.document);
      return reply(200, {
        projectId: initial.projectId,
        clientMutationId: body.clientMutationId,
        revision,
      });
    }
    return reply(404, {});
  }
  return {
    async route(route) {
      const request = route.request();
      await route.fulfill(
        await respond(
          new URL(request.url()).pathname,
          request.method(),
          request.headers()["x-csrf-token"],
          () => request.postDataJSON(),
        ),
      );
    },
    async middleware(request, response, next) {
      const path = new URL(request.url, "http://localhost").pathname;
      if (!path.startsWith("/api/v1/")) return next();
      try {
        const result = await respond(path, request.method, request.headers["x-csrf-token"], () =>
          json(request),
        );
        response.writeHead(result.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(result.json));
      } catch (error) {
        next(error);
      }
    },
    document: () => structuredClone(document),
    setDocument,
    async waitForDocument(matches) {
      if (matches(document)) return structuredClone(document);
      for await (const [saved] of on(saves, "saved", { signal: AbortSignal.timeout(15_000) })) {
        if (matches(saved)) return structuredClone(saved);
      }
    },
  };
}

export async function serveProject(page, origin, initial = blankProject) {
  const { route, document, setDocument, waitForDocument } = createProjectFixture(initial);
  await page.context().route("**/api/v1/**", route);
  return {
    url: new URL(`/?projectId=${initial.projectId}`, origin).href,
    document,
    setDocument,
    waitForDocument,
  };
}

export async function openSavedProject(page) {
  const recovery = page.getByRole("dialog", { name: "Recover your changes?" });
  const ready = page.getByRole("status").filter({ hasText: "Scene ready" });
  await Promise.race([recovery.waitFor(), ready.waitFor()]);
  if (await recovery.isVisible())
    await recovery.getByRole("button", { name: "Use saved version" }).click();
  await ready.waitFor().catch(async (error) => {
    throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
  });
}

// Follow the same inline scene rename interaction as the editor.
export async function sceneNameInput(page) {
  const toggle = page.getByRole("button", { name: "Scenes", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const input = page.getByRole("textbox", { name: "Scene name", exact: true });
  if (!(await input.isVisible())) await page.locator('.scene-name[aria-pressed="true"]').dblclick();
  await input.waitFor();
  return input;
}
