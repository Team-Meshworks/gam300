import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createLoopbackProxy, validateLoopbackURL } from "./browser-network.mjs";

// Chrome's 2026-10-27 stable security release. Keep this floor under review;
// passing it establishes coverage for that release, not immunity to future CVEs.
// https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_0562499947.html
export const MINIMUM_CHROME_VERSION = "156.0.8078.73";

export function validateChromeVersion(output) {
  const match = String(output)
    .trim()
    .match(/^Google Chrome(?: for Testing)? (\d+\.\d+\.\d+\.\d+)\s*$/);
  if (!match)
    throw new Error(
      `Expected official Google Chrome or Chrome for Testing; received: ${String(output).trim()}`,
    );
  const version = match[1];
  const actual = version.split(".").map(Number);
  const minimum = MINIMUM_CHROME_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return version;
    if (actual[index] < minimum[index]) {
      throw new Error(
        `Chrome ${version} is below security floor ${MINIMUM_CHROME_VERSION}. Update official Chrome before running browser checks.`,
      );
    }
  }
  return version;
}

export function chromeCandidates(platform = process.platform, env = process.env) {
  // An explicit path is the only candidate when supplied. Never silently fall
  // back to another browser if that binary is missing, stale, or unrecognized.
  if (env.CHROME_PATH?.trim()) return [env.CHROME_PATH.trim()];
  if (platform === "linux")
    return ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];
  if (platform === "darwin")
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (platform === "win32")
    return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter(Boolean)
      .map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"));
  return [];
}

export function resolveVerifiedChrome() {
  const candidate = chromeCandidates().find((entry) => existsSync(entry));
  if (!candidate)
    throw new Error(
      "Official Chrome is required. Run npm run browser:install from apps/web, or set CHROME_PATH to an official Chrome for Testing binary. Bundled Chromium is not a fallback.",
    );
  const executablePath = realpathSync(candidate);
  let output;
  try {
    if (process.platform === "win32") {
      // Windows chrome.exe is a GUI executable; read its version resource
      // without launching it. Pass the path as data, never interpolate shell code.
      const metadata = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$v = (Get-Item -LiteralPath $env:SPATIA_CHROME_VERSION_PATH).VersionInfo; @{ name = $v.ProductName; version = $v.ProductVersion } | ConvertTo-Json -Compress",
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, SPATIA_CHROME_VERSION_PATH: executablePath },
          },
        ),
      );
      output = `${metadata.name} ${metadata.version}`;
    } else {
      output = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 });
    }
  } catch (cause) {
    throw new Error(`Unable to verify Chrome at ${executablePath}. No browser check was started.`, {
      cause,
    });
  }
  const version = validateChromeVersion(output);
  return { executablePath, version };
}

export function sandboxedLaunchOptions(chrome) {
  return { executablePath: chrome.executablePath, chromiumSandbox: true };
}

export function assertLinuxSandboxStatus(status) {
  // Current Chrome reports the layer-1 implementation separately from its
  // namespace checks; older versions report a direct sandbox Yes/No row.
  const hasSeccomp = /^Seccomp-BPF sandbox[ \t]+Yes[ \t]*$/im.test(status);
  const hasLegacyProcessSandbox = /^(?:Namespace sandbox|SUID sandbox)[ \t]+Yes[ \t]*$/im.test(
    status,
  );
  const hasNamespaceProcessSandbox =
    /^Layer 1 Sandbox[ \t]+Namespace[ \t]*$/im.test(status) &&
    /^PID namespaces[ \t]+Yes[ \t]*$/im.test(status) &&
    /^Network namespaces[ \t]+Yes[ \t]*$/im.test(status);
  if (!hasSeccomp || !(hasLegacyProcessSandbox || hasNamespaceProcessSandbox)) {
    throw new Error(
      `Chrome did not report an active Linux sandbox. Refusing to run browser checks.\n${status}`,
    );
  }
}

export function validateBrowserEnvironment(env = process.env, uid = process.getuid?.()) {
  if (uid === 0)
    throw new Error("Browser checks require a non-root user and an active Chrome sandbox.");
  for (const key of [
    "PLAYWRIGHT_MODULE",
    "PLAYWRIGHT_CHANNEL",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  ]) {
    if (env[key])
      throw new Error(
        `${key} is no longer supported. Set CHROME_PATH to verified official Chrome instead.`,
      );
  }
}

export function validateBrowserArguments(args = []) {
  // The 3D fixtures require software WebGL. This flag does not disable process
  // sandboxing. All other launch switches are owned by this policy, not callers.
  if (!Array.isArray(args) || args.some((arg) => arg !== "--enable-unsafe-swiftshader")) {
    throw new Error(
      "Unsupported browser launch argument. Security and proxy switches cannot be overridden.",
    );
  }
  return args;
}

export function safeContextOptions(options = {}) {
  if (options.proxy || options.serviceWorkers === "allow") {
    throw new Error(
      "Browser contexts cannot override the local-only proxy or enable service workers.",
    );
  }
  return { ...options, serviceWorkers: "block" };
}

async function verifyRunningSandbox(context) {
  if (process.platform !== "linux") return;
  const page = await context.newPage();
  try {
    await page.goto("chrome://sandbox");
    assertLinuxSandboxStatus(await page.locator("body").innerText());
  } finally {
    await page.close();
  }
}

async function prepare(target, args) {
  validateBrowserEnvironment();
  validateBrowserArguments(args);
  const origin = validateLoopbackURL(target).origin;
  const chrome = resolveVerifiedChrome();
  const proxy = await createLoopbackProxy([origin]);
  return {
    chrome,
    proxy,
    options: {
      ...sandboxedLaunchOptions(chrome),
      headless: true,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: [
        ...args,
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    },
  };
}

function bindProxyLifetime(owner, proxy) {
  const close = owner.close.bind(owner);
  owner.close = async (...args) => {
    try {
      return await close(...args);
    } finally {
      await proxy.close();
    }
  };
  owner.once("disconnected", () => {
    void proxy.close();
  });
  owner.once("close", () => {
    void proxy.close();
  });
  // The restart acceptance harness receives the next exact local origin over its
  // stdin handshake. It must explicitly allow that origin before navigating.
  owner.allowLocalOrigin = (origin) => proxy.allowOrigin(origin);
}

export async function launchBrowser({ target, args = [] } = {}) {
  const { chrome, proxy, options } = await prepare(target, args);
  let browser;
  try {
    browser = await chromium.launch(options);
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      await verifyRunningSandbox(context);
    } finally {
      await context.close();
    }
    const newContext = browser.newContext.bind(browser);
    browser.newContext = (contextOptions) => newContext(safeContextOptions(contextOptions));
    const newPage = browser.newPage.bind(browser);
    browser.newPage = (contextOptions) => newPage(safeContextOptions(contextOptions));
    bindProxyLifetime(browser, proxy);
    // Server acceptance stdout is a strict machine-readable protocol.
    console.error(
      `Verified Chrome ${chrome.version}; sandbox required; network restricted to local test origins.`,
    );
    return browser;
  } catch (cause) {
    await Promise.allSettled([browser?.close(), proxy.close()]);
    throw new Error(
      "Secure browser preflight failed. Use a non-root sandbox-capable host; do not disable the sandbox.",
      { cause },
    );
  }
}

export async function launchPersistentBrowser({ target, args = [] } = {}) {
  const { chrome, proxy, options } = await prepare(target, args);
  let context;
  try {
    // Empty userDataDir asks Playwright for a fresh temporary regular profile.
    // This preserves the durable file-handle tests without using a personal profile.
    context = await chromium.launchPersistentContext("", { ...options, serviceWorkers: "block" });
    await verifyRunningSandbox(context);
    bindProxyLifetime(context, proxy);
    console.error(
      `Verified Chrome ${chrome.version}; sandbox required; isolated persistent profile; local-only network.`,
    );
    return context;
  } catch (cause) {
    await Promise.allSettled([context?.close(), proxy.close()]);
    throw new Error("Secure persistent browser preflight failed. Do not disable the sandbox.", {
      cause,
    });
  }
}
