import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const root = fileURLToPath(new URL("../", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
const results = join(root, "test-results");
mkdirSync(results, { recursive: true });
const temporary = mkdtempSync(join(results, "spatia-setup-check-"));
const log = join(temporary, "calls.txt");
const revision = "0123456789012345678901234567890123456789";
const git = windows
  ? `@echo off\necho git %*>>"%SETUP_LOG%"\nif "%1"=="rev-parse" echo ${revision}\nif "%SETUP_CASE%"=="lfs" exit /b 1\nif "%SETUP_CASE%"=="download" if "%2"=="pull" exit /b 1\nexit /b 0\n`
  : `#!/bin/sh\nprintf "git %s\\n" "$*" >> "$SETUP_LOG"\nif [ "$1" = rev-parse ]; then echo ${revision}; fi\n[ "$SETUP_CASE" != lfs ] || exit 1\nif [ "$SETUP_CASE" = download ] && [ "$2" = pull ]; then exit 1; fi\nexit 0\n`;
const docker = windows
  ? '@echo off\necho docker %*>>"%SETUP_LOG%"\necho BUILD_MODE=%BUILD_MODE% REVISION=%REVISION%>>"%SETUP_LOG%"\nif "%SETUP_CASE%"=="compose" exit /b 1\nif "%1"=="info" (if "%SETUP_CASE%"=="engine" (echo windows) else (echo linux))\nif "%3"=="--help" (if not "%SETUP_CASE%"=="wait" echo --wait)\nif "%2"=="--project-name" if "%SETUP_CASE%"=="build" exit /b 1\nexit /b 0\n'
  : '#!/bin/sh\nprintf "docker %s\\nBUILD_MODE=%s REVISION=%s\\n" "$*" "$BUILD_MODE" "$REVISION" >> "$SETUP_LOG"\n[ "$SETUP_CASE" != compose ] || exit 1\nif [ "$1" = info ]; then if [ "$SETUP_CASE" = engine ]; then echo windows; else echo linux; fi; fi\nif [ "$3" = --help ]; then [ "$SETUP_CASE" = wait ] || echo --wait; fi\nif [ "$2" = --project-name ]; then [ "$SETUP_CASE" != build ] || exit 1; fi\nexit 0\n';

try {
  writeFileSync(join(temporary, windows ? "git.cmd" : "git"), git, {
    mode: 0o755,
  });
  writeFileSync(join(temporary, windows ? "docker.cmd" : "docker"), docker, {
    mode: 0o755,
  });
  for (const testCase of [
    "lfs",
    "compose",
    "engine",
    "wait",
    "mode",
    "download",
    "build",
    "success",
    "production",
  ]) {
    writeFileSync(log, "");
    const result = spawnSync(
      windows ? process.env.ComSpec : "bash",
      windows ? ["/d", "/c", "run.bat"] : ["run.sh"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...environment,
          PATH: `${temporary}${delimiter}${process.env.PATH}`,
          SETUP_CASE: testCase,
          SETUP_LOG: log,
          COMPOSE_PROJECT_NAME: "spatia-setup-check",
          APP_PORT: "8091",
          BUILD_MODE:
            testCase === "mode"
              ? "staging"
              : testCase === "production"
                ? "production"
                : "",
          REVISION: "",
        },
      },
    );
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    const calls = readFileSync(log, "utf8");
    if (testCase === "success" || testCase === "production") {
      assert.equal(result.status, 0, output + calls);
      assert.match(output, /Spatia is ready at http:\/\/localhost:8091\//);
      assert.match(calls, /git lfs pull --include=["']?assets\/delivery\/\*\*/);
      assert.ok(
        calls.includes(
          `BUILD_MODE=${testCase === "production" ? "production" : "development"} REVISION=${revision}`,
        ),
      );
      assert.match(
        calls,
        /--project-name ["']?spatia-setup-check["']? up --build --wait --wait-timeout 120/,
      );
    } else {
      assert.notEqual(result.status, 0, output);
      assert.match(output, /Setup failed:/);
      assert.doesNotMatch(output, /Spatia is ready/);
      if (testCase !== "build") assert.doesNotMatch(calls, /up --build/);
    }
  }
  console.log(
    `PASS: ${windows ? "Windows" : "POSIX"} setup checks, failure propagation and startup`,
  );
} finally {
  assert.equal(dirname(realpathSync(temporary)), realpathSync(results));
  rmSync(temporary, { recursive: true, force: true });
}
