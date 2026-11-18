import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const fixturePath = `/@fs/${fileURLToPath(new URL("./project-store-fixture.ts", import.meta.url)).replaceAll("\\", "/")}`;

// Mount the actual component/save handler; defer only the model-placement boundary.
export async function checkDisplayPlacementCancellation(browser, origin) {
  for (const dismissal of ["close", "escape", "unmount"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.route("**/__display-placement-cancellation", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><script type="module">
            import RefreshRuntime from "/@react-refresh";
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {};
            window.$RefreshSig$ = () => (type) => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script>`,
        }),
      );
      await page.goto(new URL("/__display-placement-cancellation", origin).href);
      await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
      // Resolve browser packages through Vite while preserving ordinary imports for the graph.
      await page.addScriptTag({
        type: "importmap",
        content: JSON.stringify({
          imports: {
            react: "/@id/react",
            "react-dom/client": "/@id/react-dom/client",
            "./project-store-fixture.ts": fixturePath,
          },
        }),
      });
      const supports = await page.evaluate(async () => {
        const react = await import("react");
        const reactDOM = await import("react-dom/client");
        const { createElement, StrictMode } = react.default ?? react;
        const { createRoot } = reactDOM.default ?? reactDOM;
        const { DisplayEditor } = await import("/ui/DisplayEditor.tsx");
        const { createLoadedStore } = await import("./project-store-fixture.ts");
        const { assets } = await import("/@id/__x00__virtual:asset-catalogue");
        const store = createLoadedStore(assets, "test-room-v1");
        function placeSupport(id, x) {
          const asset = assets.find((entry) => entry.id === id && entry.displayRole === "physical");
          if (!asset) throw new Error(`Missing physical support ${id}`);
          const result = store.addObject(id, [x, 0, 0]);
          if (!result.ok) throw new Error(result.error);
          return { asset, object: result.object };
        }
        const supports = {
          A: placeSupport("display-cube-v1", 0),
          B: placeSupport("display-full-glass-case-v1", 5),
        };
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const closes = [];
        const pending = [];
        window.displayCancellation = {
          closes,
          pending,
          snapshot: store.getSnapshot,
          open(support) {
            const { asset, object } = supports[support];
            root.render(
              createElement(
                StrictMode,
                null,
                createElement(DisplayEditor, {
                  key: object.id,
                  object,
                  asset,
                  assets,
                  project: store.getSnapshot().project,
                  store,
                  thumbnailFor: () => undefined,
                  placementFor(ownerId, assetId) {
                    const request = Promise.withResolvers();
                    pending.push({ ...request, ownerId, assetId, support });
                    return request.promise;
                  },
                  onClose: () => {
                    closes.push(object.id);
                    root.render(null);
                  },
                }),
              ),
            );
          },
          finish(index) {
            const { promise, resolve, support } = pending[index];
            const { object, asset } = supports[support];
            resolve({
              ...object.transform,
              position: [object.transform.position[0], asset.displayTop ?? 0, 0],
              scale: [0.2, 0.2, 0.2],
            });
            return promise;
          },
        };
        window.displayCancellation.open("A");
        return { A: supports.A.object, B: supports.B.object };
      });
      const before = await page.evaluate(() => window.displayCancellation.snapshot().project);
      const dialog = page.getByRole("dialog", { name: "Place an object on this display" });
      await dialog.getByText(supports.A.name, { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Sample crate", exact: true }).click();
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(() => window.displayCancellation.pending.length === 1);
      if (dismissal === "close") {
        await dialog.getByRole("button", { name: "Close display editor" }).click();
      } else if (dismissal === "escape") {
        await page.keyboard.press("Escape");
      }
      if (dismissal !== "unmount") await dialog.waitFor({ state: "hidden" });
      await page.evaluate(() => window.displayCancellation.open("B"));
      const replacement = dialog.getByText(supports.B.name, { exact: true });
      await replacement.waitFor();
      assert.deepEqual(
        await page.evaluate(() =>
          window.displayCancellation.pending.map(({ assetId, ownerId }) => ({ assetId, ownerId })),
        ),
        [{ assetId: "test-crate-v1", ownerId: supports.A.id }],
      );
      await page.evaluate(() => window.displayCancellation.finish(0));
      assert.deepEqual(
        await page.evaluate(() => window.displayCancellation.snapshot().project),
        before,
        `Late placement after ${dismissal} must leave the draft unchanged`,
      );
      assert.deepEqual(
        await page.evaluate(() => window.displayCancellation.closes),
        dismissal === "unmount" ? [] : [supports.A.id],
        "The stale operation must not close B",
      );
      assert.equal(await replacement.isVisible(), true);
      // The replacement dialog still saves normally, including under StrictMode replay.
      await dialog.getByRole("button", { name: "Sample crate", exact: true }).click();
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(() => window.displayCancellation.pending.length === 2);
      const fitted = await page.evaluate(() => window.displayCancellation.finish(1));
      await dialog.waitFor({ state: "hidden" });
      const objects = await page.evaluate(() => window.displayCancellation.snapshot().objects);
      assert.deepEqual(
        objects.slice(0, 2).map(({ id }) => id),
        [supports.A.id, supports.B.id],
      );
      assert.deepEqual(
        objects
          .slice(2)
          .map(({ assetId, parentId, transform }) => ({ assetId, parentId, transform })),
        [{ assetId: "test-crate-v1", parentId: supports.B.id, transform: fitted }],
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error(dismissal, errors, await page.locator("body").innerText());
      throw error;
    } finally {
      await page.close();
    }
  }
  console.log(
    "PASS: closing, Escape and unmount cancel pending display placement; replacement dialog remains usable.",
  );
}
