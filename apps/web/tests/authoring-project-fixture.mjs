import { readFileSync } from "node:fs";

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

export async function serveProject(page, origin, initial = blankProject) {
  let document = structuredClone(initial);
  let revision = 0;
  await page.context().route("**/api/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) => route.fulfill({ status, json: body });
    if (path === "/api/v1/auth/session")
      return json(200, {
        userId: "00000000-0000-4000-8000-000000000001",
        orgId: "00000000-0000-4000-8000-000000000002",
        displayName: "Browser test",
        role: "Creator",
        mustChangePassword: false,
        developmentAssetsAllowed: true,
      });
    if (path === "/api/v1/auth/csrf") return json(200, { requestToken: "test-token" });
    if (path === "/api/v1/assets") return json(200, []);
    if (path === `/api/v1/projects/${initial.projectId}/assets`) return json(200, []);
    if (path === `/api/v1/projects/${initial.projectId}`) {
      if (request.method() === "GET")
        return json(200, {
          projectId: initial.projectId,
          revision,
          document,
          permissions: { canEdit: true },
        });
      const body = request.postDataJSON();
      if (body.expectedRevision !== revision || request.headers()["x-csrf-token"] !== "test-token")
        return json(409, {});
      document = body.document;
      return json(200, {
        projectId: initial.projectId,
        clientMutationId: body.clientMutationId,
        revision: ++revision,
      });
    }
    return json(404, {});
  });
  return {
    url: new URL(`/?projectId=${initial.projectId}`, origin).href,
    document: () => structuredClone(document),
    setDocument: (next) => {
      document = structuredClone(next);
      revision++;
    },
  };
}

export async function openSavedProject(page) {
  const recovery = page.getByRole("dialog", { name: "A recovery copy is available" });
  const ready = page.getByRole("status").filter({ hasText: "Scene ready" });
  await Promise.race([recovery.waitFor(), ready.waitFor()]);
  if (await recovery.isVisible())
    await recovery.getByRole("button", { name: "Use server version and discard recovery" }).click();
  await ready.waitFor().catch(async (error) => {
    throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
  });
}
