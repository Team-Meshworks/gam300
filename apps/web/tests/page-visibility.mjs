import { on } from "node:events";

export async function withVisibilityPage(page, run) {
  const context = page.context();
  const host = await context.newCDPSession(page);
  let browserContextId;
  try {
    browserContextId = (await host.send("Target.getTargetInfo")).targetInfo.browserContextId;
  } finally {
    await host.detach();
  }
  const browser = await context.browser().newBrowserCDPSession();
  let targetId;
  try {
    // A hidden target supports native visibility changes through focus emulation
    ({ targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
      background: true,
      hidden: true,
    }));
    // Send commands through the nested session because the hidden target is not a Playwright page
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: false });
    let nextId = 0;
    async function receive(matches, trigger) {
      const messages = on(browser, "Target.receivedMessageFromTarget", {
        signal: AbortSignal.timeout(30_000),
      });
      try {
        await trigger();
        for await (const [event] of messages) {
          if (event.sessionId !== sessionId) continue;
          const message = JSON.parse(event.message);
          if (matches(message)) return message;
        }
        throw new Error("The Chrome visibility target closed");
      } finally {
        await messages.return();
      }
    }
    async function send(method, params = {}) {
      const id = ++nextId;
      const reply = await receive(
        (message) => message.id === id,
        () =>
          browser.send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id, method, params }),
          }),
      );
      if (reply.error) throw new Error(`${method} failed: ${reply.error.message}`);
      return reply.result;
    }
    async function evaluate(fn, arg, { userGesture = false } = {}) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`,
        returnByValue: true,
        awaitPromise: true,
        userGesture,
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    }
    await send("Page.enable");
    return await run({
      evaluate,
      async goto(url) {
        await receive(
          (message) => message.method === "Page.domContentEventFired",
          async () => {
            const { errorText } = await send("Page.navigate", { url });
            if (errorText) throw new Error(`Could not open the visibility fixture: ${errorText}`);
          },
        );
      },
      async setVisible(visible) {
        await send("Emulation.setFocusEmulationEnabled", { enabled: visible });
        if ((await evaluate(() => document.hidden)) === visible)
          throw new Error("Chrome did not change the document visibility");
      },
    });
  } finally {
    try {
      if (targetId) await browser.send("Target.closeTarget", { targetId });
    } finally {
      await browser.detach();
    }
  }
}
