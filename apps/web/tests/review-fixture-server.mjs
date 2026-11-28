import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
export const workspaceFixture = "/tests/review-workspace-fixture.html";
const workspaceFixtureEntry =
  "/@fs/" +
  fileURLToPath(new URL("./review-workspace-fixture.tsx", import.meta.url))
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");

export const reviewFixturePlugins = [
  {
    name: "review-workspace-test-fixture",
    configureServer(vite) {
      vite.middlewares.use(workspaceFixture, async (_request, response, next) => {
        try {
          const source = await readFile(
            new URL("./review-workspace-fixture.html", import.meta.url),
            "utf8",
          );
          const html = await vite.transformIndexHtml(
            workspaceFixture,
            source.replace("./review-workspace-fixture.tsx", workspaceFixtureEntry),
          );
          response.setHeader("Content-Type", "text/html");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  },
];
