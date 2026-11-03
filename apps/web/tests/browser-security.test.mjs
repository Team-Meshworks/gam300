import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MINIMUM_CHROME_VERSION,
  validateChromeVersion,
  chromeCandidates,
  assertLinuxSandboxStatus,
  validateBrowserEnvironment,
  validateBrowserArguments,
  safeContextOptions,
  sandboxedLaunchOptions,
} from "./browser-security.mjs";

test("reject stale, malformed and unofficial browsers before launch", () => {
  for (const output of [
    "Chromium 156.0.8078.80",
    "Google Chrome 153.0.8010.12",
    "Google Chrome 156.0.8078.4",
    "156.0.8078.80",
    "Google Chrome 156.0.8078.80 extra",
  ]) {
    assert.throws(() => validateChromeVersion(output));
  }
  assert.equal(
    validateChromeVersion(`Google Chrome ${MINIMUM_CHROME_VERSION}`),
    MINIMUM_CHROME_VERSION,
  );
  assert.equal(validateChromeVersion("Google Chrome for Testing 156.0.8078.80\n"), "156.0.8078.80");
  assert.equal(validateChromeVersion("Google Chrome 157.0.0.1"), "157.0.0.1");
});

test("explicit browser path never falls back to bundled or system browsers", () => {
  assert.deepEqual(chromeCandidates("linux", { CHROME_PATH: "/missing/chrome" }), [
    "/missing/chrome",
  ]);
  assert.ok(chromeCandidates("linux", {}).every((path) => !path.includes("playwright")));
  assert.deepEqual(sandboxedLaunchOptions({ executablePath: "/verified/chrome" }), {
    executablePath: "/verified/chrome",
    chromiumSandbox: true,
  });
});

test("require non-root, no legacy overrides, and no unsafe launch/context overrides", () => {
  assert.throws(() => validateBrowserEnvironment({}, 0), /non-root/);
  validateBrowserEnvironment({}, 1000);
  for (const key of [
    "PLAYWRIGHT_CHANNEL",
    "PLAYWRIGHT_MODULE",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  ]) {
    assert.throws(
      () => validateBrowserEnvironment({ [key]: "override" }, 1000),
      /no longer supported/,
    );
  }
  validateBrowserArguments(["--enable-unsafe-swiftshader"]);
  for (const flag of [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-web-security",
    "--proxy-server=direct://",
    "--disable-features=Sandbox",
  ]) {
    assert.throws(() => validateBrowserArguments([flag]));
  }
  assert.throws(() => safeContextOptions({ proxy: { server: "direct://" } }));
  assert.throws(() => safeContextOptions({ serviceWorkers: "allow" }));
  assert.equal(safeContextOptions({ ignoreHTTPSErrors: true }).serviceWorkers, "block");
});

test("Linux sandbox requires both process isolation and seccomp", () => {
  assertLinuxSandboxStatus("Namespace sandbox\tYes\nSeccomp-BPF sandbox\tYes");
  assertLinuxSandboxStatus(
    "Layer 1 Sandbox\tNamespace\nPID namespaces\tYes\nNetwork namespaces\tYes\nSeccomp-BPF sandbox\tYes",
  );
  for (const text of [
    "",
    "Namespace sandbox\tYes",
    "Seccomp-BPF sandbox\tYes",
    "Layer 1 Sandbox\tNamespace\nPID namespaces\tYes\nSeccomp-BPF sandbox\tYes",
  ]) {
    assert.throws(() => assertLinuxSandboxStatus(text));
  }
});

test("all repository browser launches use the security helper", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const failures = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", ".artifacts", "test-results", "dist", "bin", "obj"].includes(
          entry.name,
        )
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      if (!/\.(?:mjs|cjs|js|ts|tsx)$/.test(entry.name)) continue;
      if (
        ["browser-security.mjs", "browser-security.test.mjs"].includes(entry.name) &&
        dirname(path) === dirname(fileURLToPath(import.meta.url))
      )
        continue;
      const text = await readFile(path, "utf8");
      if (
        /\b(?:from\s*|import\s*\(|require\s*\()\s*["'](?:@playwright\/test|playwright(?:-core)?)(?:["'/])/.test(
          text,
        ) ||
        /\.\s*(?:launchPersistentContext|launchServer|connectOverCDP)\s*\(/.test(text) ||
        /\b(?:chromium|firefox|webkit)\s*\.\s*(?:launch|connect)\s*\(/.test(text)
      )
        failures.push(relative(root, path));
    }
  }
  await scan(root);
  assert.deepEqual(
    failures,
    [],
    "New browser runners must use browser-security.mjs, including integration branches.",
  );
});
