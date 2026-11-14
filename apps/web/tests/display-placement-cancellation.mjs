import assert from "node:assert/strict";

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
          imports: { react: "/@id/react", "react-dom/client": "/@id/react-dom/client" },
        }),
      });
      await page.evaluate(async () => {
        const react = await import("react");
        const reactDOM = await import("react-dom/client");
        const { createElement, StrictMode } = react.default ?? react;
        const { createRoot } = reactDOM.default ?? reactDOM;
        const { DisplayEditor } = await import("/ui/DisplayEditor.tsx");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        const project = {};
        const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
        const asset = { id: "display", name: "Display", kind: "model", displayRole: "physical" };
        const crate = {
          id: "crate",
          name: "Deferred crate",
          kind: "model",
          sha256: "b".repeat(64),
        };
        const writes = [],
          closes = [],
          pending = [];
        const store = {
          getSnapshot: () => ({ project, objects: [] }),
          addAttachedObject: (assetId, ownerId) => {
            writes.push({ assetId, ownerId });
            return { ok: true };
          },
        };
        window.displayCancellation = {
          writes,
          closes,
          pending,
          open(id) {
            root.render(
              createElement(
                StrictMode,
                null,
                createElement(DisplayEditor, {
                  key: id,
                  object: { id, name: id, transform },
                  asset,
                  assets: [asset, crate],
                  project,
                  store,
                  thumbnailFor: () => undefined,
                  placementFor: () => new Promise((resolve) => pending.push(resolve)),
                  onClose: () => {
                    closes.push(id);
                    root.render(null);
                  },
                }),
              ),
            );
          },
          async finish(index) {
            pending[index](transform);
            await new Promise((resolve) => setTimeout(resolve, 0));
          },
        };
        window.displayCancellation.open("A");
      });
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Deferred crate", exact: true }).click();
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(() => window.displayCancellation.pending.length === 1);
      if (dismissal === "close") {
        await dialog.getByRole("button", { name: "Close display editor" }).click();
      } else if (dismissal === "escape") {
        await page.keyboard.press("Escape");
      }
      if (dismissal !== "unmount") await dialog.waitFor({ state: "hidden" });
      await page.evaluate(() => window.displayCancellation.open("B"));
      await dialog.getByText("B", { exact: true }).waitFor();
      await page.evaluate(() => window.displayCancellation.finish(0));
      assert.deepEqual(await page.evaluate(() => window.displayCancellation.writes), [], dismissal);
      assert.deepEqual(
        await page.evaluate(() => window.displayCancellation.closes),
        dismissal === "unmount" ? [] : ["A"],
        "The stale operation must not close B",
      );
      assert.equal(await dialog.isVisible(), true);
      // The replacement dialog still saves normally, including under StrictMode replay.
      await dialog.getByRole("button", { name: "Deferred crate", exact: true }).click();
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await page.waitForFunction(() => window.displayCancellation.pending.length === 2);
      await page.evaluate(() => window.displayCancellation.finish(1));
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.displayCancellation.writes), [
        { assetId: "crate", ownerId: "B" },
      ]);
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
