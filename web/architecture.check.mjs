import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { createServer } from "vite";
import { chromium } from "playwright";
import { compilerOptions, dependents, moduleOf, modules, scan, webRoot } from "./architecture.mjs";

// Used to observe the real missing tooling dependency after removal
if (process.argv.includes("--probe-import")) {
  console.log("PASS: architecture check imports its build tooling");
  process.exit(0);
}

const baseline = scan();
assert.deepEqual(baseline.errors, [], "Start from a valid import graph");
const results = resolve(webRoot, "test-results");
mkdirSync(results, { recursive: true });
const isolatedResults = resolve(webRoot, "../test-results");
mkdirSync(isolatedResults, { recursive: true });
const temporary = mkdtempSync(resolve(isolatedResults, "ti01-isolated-"));
const report = { sourceHashes: baseline.graph.files, violations: [], removals: [] };
const code = (file) => /\.[cm]?[jt]sx?$/.test(file);
const files = Object.keys(baseline.graph.files);

function copy(name) {
  const directory = resolve(temporary, name);
  const root = resolve(directory, "web");
  cpSync(webRoot, root, {
    recursive: true,
    filter: (path) =>
      !["node_modules", "dist", "test-results", ".git"].includes(path.split(/[\\/]/).at(-1)),
  });
  symlinkSync(
    resolve(webRoot, "node_modules"),
    resolve(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    resolve(webRoot, "../assets"),
    resolve(directory, "assets"),
    process.platform === "win32" ? "junction" : "dir",
  );
  mkdirSync(resolve(directory, "docs"));
  for (const file of ["architecture-graph.md", "architecture-graph.json"]) {
    cpSync(resolve(webRoot, "../docs", file), resolve(directory, "docs", file));
  }
  return root;
}

function command(root, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.ifError(result.error);
  return {
    command: `node ${args.join(" ")}`,
    status: result.status,
    output: result.stdout + result.stderr,
  };
}

const options = { ...compilerOptions(webRoot), allowJs: true, checkJs: false };
const nodeConfig = ts.readConfigFile(resolve(webRoot, "tsconfig.node.json"), ts.sys.readFile);
const nodeOptions = {
  ...ts.parseJsonConfigFileContent(nodeConfig.config, ts.sys, webRoot).options,
  allowJs: true,
  checkJs: false,
};

function typecheck(root, name, cache) {
  const settings = name === "build" ? nodeOptions : options;
  const host = ts.createCompilerHost(settings);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError) => {
    // Reuse parsed dependencies between independent programs; never cache missing files
    if (!cache.has(path) && existsSync(path))
      cache.set(path, getSourceFile(path, languageVersion, onError));
    return cache.get(path);
  };
  const roots = files
    .filter((file) => code(file) && moduleOf(file) === name)
    .map((file) => resolve(root, file));
  // The catalogue's Vite module is an ambient contract, not a directly imported .d.ts
  if (["editor", "checks"].includes(name)) {
    const declaration = resolve(root, "shared/assets/manifest-module.d.ts");
    if (existsSync(declaration)) roots.push(declaration);
  }
  const program = ts.createProgram(roots, settings, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const location =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
      return `${diagnostic.file?.fileName.replace(root.replaceAll("\\", "/"), "web") ?? name}${location ? ":" + (location.line + 1) : ""}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    });
}

async function browserEntry(root) {
  const server = await createServer({
    configFile: resolve(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({
      args: ["--enable-unsafe-swiftshader"],
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    });
    const page = await browser.newPage();
    const response = await page.goto(server.resolvedUrls.local[0]);
    if (response.status() !== 200) return `Browser editor entry returned HTTP ${response.status()}`;
    await page.getByRole("heading", { name: "Spatia", exact: true }).waitFor({ timeout: 2000 });
    return undefined;
  } catch (error) {
    return `Browser editor entry failed: ${error.message}`;
  } finally {
    await browser?.close();
    await server.close();
  }
}

function unitDependsOn(test, removed, visited = new Set()) {
  if (visited.has(test)) return false;
  visited.add(test);
  return baseline.graph.imports
    .filter((entry) => entry.file === test && typeof entry.target === "string")
    .some(
      (entry) =>
        moduleOf(entry.target) === removed || unitDependsOn(entry.target, removed, visited),
    );
}

try {
  const root = copy("violations");
  const projectFile = "shared/project/project-types.ts";
  const original = readFileSync(resolve(root, projectFile), "utf8");
  const configPath = resolve(root, "tsconfig.app.json");
  const config = readFileSync(configPath, "utf8");
  const cases = [
    [
      "type-only cycle",
      'import type { ViewportStatus } from "../../editor/graphics/scene";',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "dynamic + Vite query",
      'void import("../../editor/graphics/scene.ts?probe");',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "type query",
      'type Probe = import("../../editor/graphics/scene.ts").ViewportStatus;',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "re-export",
      'export type { ViewportStatus } from "../../editor/graphics/scene.js";',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "tsconfig alias + JS extension",
      'import type { ViewportStatus } from "@render/scene.js";',
      /forbidden dependency project -> rendering/,
      true,
    ],
    ["directory index", 'import "../../editor/";', /forbidden dependency project -> editor/, true],
    [
      "external dependency",
      'import type { ReactNode } from "react";',
      /project cannot import package react/,
      false,
    ],
    [
      "CommonJS dependency",
      'require("../../editor/graphics/scene");',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "Vite root URL",
      'void import("/graphics/scene.ts");',
      /forbidden dependency project -> rendering/,
      true,
    ],
    [
      "implicit JSX dependency",
      "export const Probe = <div />;",
      /project cannot import package react/,
      false,
      "shared/project/probe.tsx",
    ],
    [
      "computed import",
      'const probe = "../../editor/graphics/scene"; void import(probe);',
      /computed import cannot be checked/,
      false,
    ],
    ["missing import", 'import "./missing-module";', /unresolved import/, false],
    ["case mismatch", 'import "./Project-Types.ts";', /casing|unresolved import/, false],
    [
      "private command implementation",
      'import type { EditCommand } from "./command-history";',
      /private contract document/,
      false,
      "editor/App.tsx",
    ],
  ];
  for (const [name, addition, expected, cycle, target = projectFile] of cases) {
    const path = resolve(root, target);
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, "utf8") : "";
    if (name.startsWith("tsconfig alias"))
      writeFileSync(
        configPath,
        config.replace(
          '"compilerOptions": {',
          '"compilerOptions": { "paths": { "@render/*": ["./editor/graphics/*"] },',
        ),
      );
    if (name === "directory index")
      writeFileSync(resolve(root, "editor/index.ts"), 'export { App } from "./App";\n');
    writeFileSync(path, text + "\n" + addition + "\n");
    const result = command(root, ["architecture.mjs"]);
    assert.equal(result.status, 1, `${name} must fail the real CLI`);
    assert.match(result.output, expected, name);
    if (cycle) assert.match(result.output, /Module cycle:/, name);
    report.violations.push({ name, ...result });
    if (existed) writeFileSync(path, text);
    else rmSync(path);
    writeFileSync(configPath, config);
    if (name === "directory index") rmSync(resolve(root, "editor/index.ts"));
  }
  assert.equal(readFileSync(resolve(root, projectFile), "utf8"), original);
  const restored = command(root, ["architecture.mjs"]);
  assert.equal(restored.status, 0, restored.output);
  report.restored = restored;
  console.log(
    `PASS: ${cases.length} isolated forbidden-import/resolution probes; restored copy passes`,
  );

  const baselineRoot = copy("baseline");
  const baselineCache = new Map();
  for (const name of Object.keys(modules))
    assert.deepEqual(
      typecheck(baselineRoot, name, baselineCache),
      [],
      `${name} must typecheck independently before removal`,
    );
  assert.equal(
    await browserEntry(baselineRoot),
    undefined,
    "The isolated browser entry must work before removal",
  );

  for (const removed of Object.keys(modules)) {
    const root = copy(`remove-${removed}`);
    const removedFiles = files.filter((file) => moduleOf(file) === removed);
    assert.ok(removedFiles.length, `${removed} must contain implemented files`);
    for (const file of removedFiles) {
      const target = resolve(root, file);
      assert.ok(target.startsWith(root + "/") || target.startsWith(root + "\\"));
      rmSync(target);
    }
    const expected = dependents(removed);
    const failed = {};
    const passed = [];
    const cache = new Map();
    for (const name of Object.keys(modules).filter((name) => name !== removed)) {
      const diagnostics = typecheck(root, name, cache);
      if (name === "checks") {
        // The browser drivers import Vite URLs inside page.evaluate; tsc does not resolve them
        diagnostics.push(
          ...scan(root).errors.filter((error) =>
            files.some((file) => moduleOf(file) === "checks" && error.startsWith(file + ":")),
          ),
        );
        if (removed === "editor") {
          const error = await browserEntry(root);
          if (error) diagnostics.push(error);
        }
        const probe = command(root, ["architecture.check.mjs", "--probe-import"]);
        if (probe.status !== 0) diagnostics.push(probe.output);
      }
      if (diagnostics.length) failed[name] = diagnostics;
      else passed.push(name);
    }
    assert.deepEqual(
      Object.keys(failed).sort(),
      expected,
      `${removed}: observed failures must equal the declared dependent closure`,
    );
    const unitFiles = files.filter(
      (file) => file.endsWith(".test.ts") && removed !== "checks" && !unitDependsOn(file, removed),
    );
    let units;
    if (unitFiles.length) {
      units = command(root, [
        "node_modules/vitest/vitest.mjs",
        "run",
        ...unitFiles,
        "--reporter=json",
        "--outputFile=test-results/removal-units.json",
      ]);
      assert.equal(units.status, 0, units.output);
      const summary = JSON.parse(
        readFileSync(resolve(root, "test-results/removal-units.json"), "utf8"),
      );
      units.testsPassed = summary.numPassedTests;
      units.files = unitFiles;
    }
    report.removals.push({
      removed,
      removedFiles,
      expected,
      affected: Object.keys(failed).sort(),
      passed,
      failed,
      units,
    });
    console.log(
      `PASS: remove ${removed}; affected [${expected.join(", ")}]; unrelated programs pass${units ? `; ${units.testsPassed} unrelated tests pass` : ""}`,
    );
  }
  assert.deepEqual(
    scan().graph.files,
    baseline.graph.files,
    "Isolation must leave the active source unchanged",
  );
  writeFileSync(
    resolve(results, "architecture-proof.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("PASS: all module-removal closures match; active source hashes unchanged");
} finally {
  // Only remove the disposable directory we created, never its junction targets
  assert.equal(dirname(realpathSync(temporary)), realpathSync(isolatedResults));
  rmSync(temporary, { recursive: true, force: true });
}
