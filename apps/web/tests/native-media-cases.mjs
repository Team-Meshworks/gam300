import assert from "node:assert/strict";
import { withVisibilityPage } from "./page-visibility.mjs";

const permissionWarning = "Select Enable audio to allow playback";
const ready = "Exhibition ready";

export async function checkNativeMedia(browser, origin) {
  async function check(scenario, verify) {
    const page = await browser.newPage();
    const pageErrors = [];
    const requestFailures = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) =>
      requestFailures.push({ url: request.url(), error: request.failure()?.errorText }),
    );
    page.on("response", (response) => {
      if (response.status() >= 400)
        requestFailures.push({ url: response.url(), status: response.status() });
    });
    try {
      const started = page.waitForEvent(
        "console",
        (message) => message.text() === "Native media fixture ready",
      );
      const errored = page.waitForEvent("pageerror").then((error) => {
        throw error;
      });
      try {
        await Promise.race([
          Promise.all([page.goto(`${origin}/__native-media?case=${scenario}`), started]),
          errored,
        ]);
      } catch (cause) {
        const state = await page
          .evaluate(() => ({
            ready: document.readyState,
            visibility: document.visibilityState,
            attempts: window.mediaProbe?.attempts.length,
            media: [...document.querySelectorAll("audio,video")].map((node) => ({
              url: node.currentSrc,
              network: node.networkState,
              ready: node.readyState,
              error: node.error?.message,
            })),
          }))
          .catch(() => null);
        throw new Error(
          `Native media ${scenario} did not start: ${JSON.stringify({ state, requestFailures })}`,
          { cause },
        );
      }
      await verify(page, page.locator("#activate"));
      assert.deepEqual(pageErrors, [], scenario);
    } finally {
      await page.close();
    }
  }

  await check("context", async (page, enable) => {
    assert.deepEqual(await page.evaluate(() => mediaProbe.visit.reports), [permissionWarning]);
    await enable.click();
    await page.getByText(ready, { exact: true }).waitFor();
  });

  await check("hide-one", async (page, enable) => {
    const hidden = await page.evaluate(async () => {
      const { runtime, owners, reports } = mediaProbe.visit;
      const outcomes = await mediaProbe.settleMedia();
      runtime.update(1);
      return { outcomes, hidden: owners[0].hidden, status: reports.at(-1) };
    });
    assert.deepEqual(hidden, {
      outcomes: ["NotAllowedError", "NotAllowedError"],
      hidden: true,
      status: permissionWarning,
    });
    await enable.click();
    await page.getByText(ready, { exact: true }).waitFor();
    await enable.click();
    const retries = await page.evaluate(() =>
      mediaProbe.visit.nodes.map(
        (node) => mediaProbe.attempts.filter((attempt) => attempt.node === node).length,
      ),
    );
    assert.deepEqual(retries, [1, 2]);
  });

  await check("hide-last", async (page) => {
    const statuses = await page.evaluate(() => {
      mediaProbe.visit.runtime.update(1);
      return mediaProbe.visit.reports;
    });
    assert.deepEqual(statuses, [permissionWarning, ready]);
  });

  for (const scenario of ["hidden-pending", "shown-pending", "fresh"]) {
    await check(scenario, async (page, enable) => {
      const rejected = await page.evaluate(async () => ({
        outcomes: await mediaProbe.settleMedia(),
        reports: mediaProbe.visit.reports,
        hidden: mediaProbe.visit.owners[0].hidden,
      }));
      assert.deepEqual(rejected, {
        outcomes: ["NotAllowedError"],
        reports: [],
        hidden: scenario !== "shown-pending",
      });
      await enable.click();
      const outcomes = await page.evaluate(() => mediaProbe.settleMedia());
      assert.deepEqual(
        outcomes,
        scenario === "fresh" ? ["NotAllowedError", "playing"] : ["NotAllowedError"],
      );
      assert.deepEqual(await page.evaluate(() => mediaProbe.visit.reports), []);
    });
  }

  await check("removed", async (page, enable) => {
    await page.evaluate(() => mediaProbe.visit.panels[0].remove());
    await enable.click();
    const outcome = await page.evaluate(() => ({
      status: mediaProbe.visit.reports.at(-1),
      attempts: mediaProbe.attempts.length,
    }));
    assert.deepEqual(outcome, { status: ready, attempts: 1 });
  });

  await check("superseded", async (page, enable) => {
    const observed = await page.evaluate(async () => ({
      outcomes: await mediaProbe.settleMedia(),
      statuses: mediaProbe.visit.reports,
      reportsBeforeLatest: mediaProbe.attempts[1].reportsBeforeCompletion,
      hidden: mediaProbe.visit.owners[0].hidden,
    }));
    assert.deepEqual(observed, {
      outcomes: ["NotAllowedError", "NotAllowedError"],
      statuses: [permissionWarning],
      reportsBeforeLatest: 0,
      hidden: false,
    });
    await enable.click();
    await page.getByText(ready, { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => mediaProbe.settleMedia()), [
      "NotAllowedError",
      "NotAllowedError",
      "playing",
    ]);
  });

  await check("disposed", async (page, enable) => {
    await enable.click();
    const result = await page.evaluate(async () => ({
      outcomes: await mediaProbe.settleMedia(),
      reports: mediaProbe.visit.reports,
      paused: mediaProbe.visit.nodes[0].paused,
    }));
    assert.deepEqual(result.outcomes, ["NotAllowedError", "playing"]);
    assert.deepEqual(result.reports, [permissionWarning]);
    assert.equal(result.paused, true);
  });

  await check("partial", async (page, enable) => {
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const delayedUrl = `${origin}/fixture-media/audio?delayed`;
    await page.route(delayedUrl, async (route) => {
      await gate;
      await route.continue({ url: `${origin}/fixture-media/audio` });
    });
    try {
      await Promise.all([
        page.waitForRequest(delayedUrl),
        page.evaluate((url) => {
          mediaProbe.visit.nodes[1].src = url;
        }, delayedUrl),
      ]);
      await enable.click();
      assert.deepEqual(await page.evaluate(() => mediaProbe.settleMedia()), [
        "NotAllowedError",
        "NotAllowedError",
        "playing",
      ]);
      assert.equal(await page.evaluate(() => mediaProbe.visit.reports.at(-1)), permissionWarning);
      release();
      await page.getByText(ready, { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => mediaProbe.settleMedia()), [
        "NotAllowedError",
        "NotAllowedError",
        "playing",
        "playing",
      ]);
    } finally {
      release();
    }
  });

  await check("actions", async (page, enable) => {
    await enable.click();
    const result = await page.evaluate(async () => {
      const { runner, other, spatial } = mediaProbe.actions;
      const first = mediaProbe.attempts[0].node;
      await mediaProbe.settleMedia();
      const running = !first.paused;
      other.stop();
      const separate = !first.paused;
      runner.run({ type: "play-audio", url: "/fixture-media/audio" });
      const previousStopped = first.paused;
      const second = mediaProbe.attempts[1].node;
      await mediaProbe.settleMedia();
      runner.stop();
      runner.stop();
      const stopped =
        second.paused && mediaProbe.pauses.filter((node) => node === second).length === 1;
      runner.run({ type: "play-audio", mediaId: "missing" });
      const missing = mediaProbe.attempts.length;
      runner.run({ type: "play-audio", mediaId: "track" });
      await mediaProbe.settleMedia();
      const track = mediaProbe.attempts[2].node;
      runner.run({ type: "play-audio", mediaId: "track" });
      const linked = {
        count: mediaProbe.attempts.length,
        loop: track.loop,
        volume: track.volume,
        running: !track.paused,
      };
      runner.stop();
      const linkedStopped = track.paused;
      runner.run({ type: "play-audio", mediaId: "spatial" });
      await mediaProbe.settleMedia();
      const delegated = mediaProbe.attempts.at(-1).node === spatial;
      spatial.pause();
      return {
        source: first.getAttribute("src"),
        running,
        separate,
        previousStopped,
        stopped,
        missing,
        linked,
        linkedStopped,
        delegated,
      };
    });
    assert.deepEqual(result, {
      source: "/fixture-media/audio",
      running: true,
      separate: true,
      previousStopped: true,
      stopped: true,
      missing: 2,
      linked: { count: 3, loop: true, volume: 0.4, running: true },
      linkedStopped: true,
      delegated: true,
    });
    const dialog = page.waitForEvent("dialog");
    const action = page.evaluate(() => mediaProbe.actions.runner.run({ type: "print-hi" }));
    const alert = await dialog;
    assert.equal(alert.message(), "hi");
    await alert.accept();
    await action;
  });

  await check("display-denied", async (page, enable) => {
    const blocked = await page.evaluate(async () => ({
      outcomes: await mediaProbe.settleMedia(),
      muted: mediaProbe.display.video().muted,
      paused: mediaProbe.display.video().paused,
    }));
    assert.deepEqual(blocked, {
      outcomes: ["NotAllowedError", "playing"],
      muted: true,
      paused: false,
    });
    await enable.click();
    const audible = await page.evaluate(async () => ({
      outcomes: await mediaProbe.settleMedia(),
      muted: mediaProbe.display.video().muted,
    }));
    assert.deepEqual(audible, {
      outcomes: ["NotAllowedError", "playing", "playing"],
      muted: false,
    });
    await enable.click();
    assert.equal(await page.evaluate(() => mediaProbe.attempts.length), 3);
  });

  await check("display", async (page, enable) => {
    await enable.click();
    const playing = await page.evaluate(async () => {
      const { display, video, attemptedBeforeLoad, object, owners, owner } = mediaProbe.display;
      const node = video();
      const group = owner.children[0];
      const initial = {
        muted: node.muted,
        autoplay: node.autoplay,
        loop: node.loop,
        paused: node.paused,
      };
      display.sync([object], owners);
      const reused = owner.children[0] === group;
      display.pause();
      const paused = node.paused;
      display.resume();
      await mediaProbe.settleMedia();
      const resumed = !node.paused;
      display.setPreview(true);
      await mediaProbe.settleMedia();
      const preview = !node.muted && !node.paused;
      display.pause();
      display.resume();
      await mediaProbe.settleMedia();
      const previewResumed = !node.paused;
      display.toggle(object.id);
      const pausedByVisitor = node.paused;
      const attempts = mediaProbe.attempts.length;
      display.pause();
      display.resume();
      const stillPaused = node.paused && mediaProbe.attempts.length === attempts;
      display.toggle(object.id);
      await mediaProbe.settleMedia();
      const toggled = !node.paused;
      display.setPreview(false);
      await mediaProbe.settleMedia();
      const edit = !node.muted && !node.paused;
      display.sync([], owners);
      const released =
        node.paused &&
        !node.hasAttribute("src") &&
        node.onloadeddata === null &&
        owner.children.length === 0;
      display.dispose();
      return {
        attemptedBeforeLoad,
        initial,
        reused,
        paused,
        resumed,
        preview,
        previewResumed,
        pausedByVisitor,
        stillPaused,
        toggled,
        edit,
        released,
      };
    });
    assert.deepEqual(playing, {
      attemptedBeforeLoad: 0,
      initial: { muted: false, autoplay: true, loop: true, paused: false },
      reused: true,
      paused: true,
      resumed: true,
      preview: true,
      previewResumed: true,
      pausedByVisitor: true,
      stillPaused: true,
      toggled: true,
      edit: true,
      released: true,
    });
    assert.deepEqual(await page.evaluate(() => mediaProbe.caseText()), {
      transparent: true,
      cornerAlpha: 0,
      fill: "#ffffff",
    });
    assert.deepEqual(await page.evaluate(() => mediaProbe.missingStandMedia()), {
      fallback: [true, true],
      loads: [],
    });
    await withVisibilityPage(page, async (target) => {
      await target.setVisible(true);
      await target.goto(`${origin}/__native-media?case=display`);
      await target.evaluate(() => {
        if (window.mediaProbe?.display) return;
        return new Promise((resolve) => {
          document.addEventListener("native-media-ready", () => resolve(), { once: true });
        });
      });
      for (const preview of [false, true]) {
        await target.evaluate(async (preview) => {
          mediaProbe.display.display.setPreview(preview);
          await mediaProbe.settleMedia();
          window.displayVisibilityChanged = new Promise((resolve) => {
            document.addEventListener("visibilitychange", () => resolve(), { once: true });
          });
        }, preview);
        await target.setVisible(false);
        assert.deepEqual(
          await target.evaluate(async () => {
            await window.displayVisibilityChanged;
            const { display, video } = mediaProbe.display;
            const before = mediaProbe.attempts.length;
            display.resume();
            window.displayVisibilityChanged = new Promise((resolve) => {
              document.addEventListener("visibilitychange", () => resolve(), { once: true });
            });
            return { paused: video().paused, resumed: mediaProbe.attempts.length !== before };
          }),
          { paused: true, resumed: false },
        );
        await target.setVisible(true);
        assert.equal(
          await target.evaluate(async () => {
            await window.displayVisibilityChanged;
            await mediaProbe.settleMedia();
            return mediaProbe.display.video().paused;
          }),
          false,
        );
      }
    });
  });
}
