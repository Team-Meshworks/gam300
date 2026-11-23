import { on } from "node:events";

export async function waitForStoredDraft(page, read) {
  const session = await page.context().newCDPSession(page);
  const updates = on(session, "Storage.indexedDBContentUpdated", {
    signal: AbortSignal.timeout(15_000),
  });
  try {
    await session.send("Storage.trackIndexedDBForOrigin", { origin: new URL(page.url()).origin });
    for (;;) {
      const draft = await read();
      if (draft) return draft;
      await updates.next();
    }
  } finally {
    await updates.return();
    await session.detach();
  }
}
