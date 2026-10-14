import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../apps/web", import.meta.url)));

for (const [mode, port, checks] of [
  [
    "dev",
    5173,
    ["editor-shell", "editor-integration", "local-drafts", "history-recovery"],
  ],
  ["preview", 4173, ["editor-build"]],
]) {
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      ...(mode === "dev" ? [] : [mode]),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { stdio: "inherit" },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (server.exitCode !== null)
        throw new Error(`The ${mode} server stopped before it was ready`);
      try {
        ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        // The server can take a moment to bind its port
      }
      if (ready) break;
      await setTimeout(1000);
    }
    if (!ready)
      throw new Error(`The ${mode} server did not become ready at ${url}`);
    for (const check of checks) {
      const child = spawn(process.execPath, [`tests/${check}.check.mjs`, url], {
        stdio: "inherit",
      });
      const [code] = await once(child, "exit");
      if (code !== 0)
        throw new Error(`Browser check ${check} failed with exit code ${code}`);
    }
  } finally {
    if (server.exitCode === null) {
      const stopped = once(server, "exit");
      server.kill();
      await stopped;
    }
  }
}
