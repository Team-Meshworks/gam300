import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// These are implemented source boundaries, not the future server/player layout
export const modules = {
  project: {
    paths: ["shared/project/"],
    uses: [],
    packages: [],
    public: [
      "shared/project/project-types.ts",
      "shared/project/scene-object.ts",
      "shared/project/spatial-validation.ts",
      "shared/project/project-validation.ts",
      "shared/project/project-serialization.ts",
      "shared/project/project-deserialization.ts",
      "shared/project/project-limits.ts",
      "shared/project/validation-helpers.ts",
      "shared/project/fixtures/m1-project.json",
    ],
  },
  catalogue: {
    paths: ["shared/assets/"],
    uses: [],
    packages: [],
    public: ["shared/assets/catalogue.ts", "shared/assets/sample-asset.ts"],
  },
  "asset-loading": {
    paths: ["shared/assets/ModelCache.ts"],
    uses: ["catalogue"],
    packages: ["three"],
    public: ["shared/assets/ModelCache.ts"],
  },
  input: {
    paths: ["editor/history-shortcuts.ts"],
    uses: [],
    packages: [],
    public: ["editor/history-shortcuts.ts"],
  },
  document: {
    paths: [
      "editor/document-store.ts",
      "editor/command-history.ts",
      "editor/transform-command.ts",
      "editor/recovery-history.ts",
    ],
    uses: ["project", "catalogue"],
    packages: [],
    public: ["editor/document-store.ts", "editor/recovery-history.ts"],
  },
  rendering: {
    paths: ["editor/graphics/", "editor/controls/"],
    uses: ["project", "catalogue", "input", "asset-loading"],
    packages: ["three"],
    public: ["editor/graphics/scene.ts", "editor/graphics/modeManager.ts"],
  },
  persistence: {
    paths: ["editor/persistence/"],
    uses: ["project", "catalogue", "document"],
    packages: ["react"],
    public: ["editor/persistence/use-project-session.ts"],
  },
  editor: {
    paths: ["editor/"],
    uses: ["project", "catalogue", "input", "document", "rendering", "persistence"],
    packages: ["react", "react-dom"],
    public: [],
  },
  build: { paths: [], uses: [], public: [] },
  checks: {
    paths: ["tests/"],
    uses: [
      "project",
      "catalogue",
      "input",
      "document",
      "asset-loading",
      "rendering",
      "persistence",
      "editor",
      "build",
    ],
    public: [],
  },
};

const slash = (path) => path.replaceAll("\\", "/");
export const webRoot = dirname(fileURLToPath(import.meta.url));

export function moduleOf(file) {
  if (
    file === "architecture.check.mjs" ||
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    file.startsWith("tests/")
  )
    return "checks";
  if (file === "shared/assets/ModelCache.ts") return "asset-loading";
  for (const [name, rule] of Object.entries(modules)) {
    if (rule.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path))) {
      return name;
    }
  }
  if (!file.includes("/") && /\.[cm]?[jt]s$/.test(file)) return "build";
  return undefined;
}

export function compilerOptions(root) {
  const config = ts.readConfigFile(resolve(root, "tsconfig.app.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}

export function scan(root = webRoot) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "test-results", ".git"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(slash(relative(root, path)));
    }
  }
  walk(root);
  files.sort();
  const options = compilerOptions(root);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const installed = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
  ]);
  const errors = [];
  const imports = [];
  const computedImports = [];
  const edges = new Map(Object.keys(modules).map((name) => [name, new Set()]));
  const contents = new Map();

  function importTarget(specifier, file) {
    if (file === "tests/caching.measure.mjs" && specifier === "/graphics/ti18-baseline.ts") {
      return {
        generated: "renderer from pinned Git revision in caching.measure.mjs",
        module: "rendering",
      };
    }
    if (["virtual:asset-catalogue", "/@id/__x00__virtual:asset-catalogue"].includes(specifier)) {
      return "shared/assets/catalogue.ts";
    }
    const clean = specifier.replace(/(?<=[^?#])[?#].*$/, "");
    const request = clean.startsWith("/") ? resolve(root, "editor", clean.slice(1)) : clean;
    const found = ts.resolveModuleName(
      request,
      resolve(root, file),
      options,
      ts.sys,
    ).resolvedModule;
    if (found && !found.isExternalLibraryImport)
      return slash(relative(root, found.resolvedFileName));
    const local = clean.startsWith(".") || isAbsolute(request);
    if (local) {
      const resource = resolve(dirname(resolve(root, file)), request);
      if (existsSync(resource)) return slash(relative(root, resource));
      return null;
    }
    if (found)
      return {
        package: clean.startsWith("@")
          ? clean.split("/").slice(0, 2).join("/")
          : clean.split("/")[0],
      };
    if (isBuiltin(clean)) return { package: "node:*" };
    return null;
  }

  function record(specifier, file, source, node, kind) {
    const from = moduleOf(file);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const target = importTarget(specifier, file);
    const entry = { file, line, kind, specifier, target, from };
    imports.push(entry);
    if (target === null) {
      errors.push(`${file}:${line}: unresolved import ${specifier}`);
      return;
    }
    if (typeof target !== "string") {
      if (target.generated) {
        entry.to = target.module;
        edges.get(from)?.add(target.module);
        return;
      }
      const allowed = modules[from]?.packages ?? [...installed, "node:*"];
      if (!allowed.includes(target.package))
        errors.push(`${file}:${line}: ${from} cannot import package ${target.package}`);
      return;
    }
    const to = moduleOf(target);
    entry.to = to;
    if (!to || target.startsWith("../")) {
      errors.push(`${file}:${line}: import outside defined modules: ${target}`);
      return;
    }
    if (!existsSync(resolve(root, target)))
      errors.push(`${file}:${line}: missing module resource ${target}`);
    // Compare against the scanned spelling even on case-insensitive hosts
    if (/\.[cm]?[jt]sx?$/.test(target) && !files.includes(target))
      errors.push(`${file}:${line}: import casing differs from source: ${target}`);
    if (from === to) return;
    edges.get(from)?.add(to);
    if (!modules[from]?.uses.includes(to))
      errors.push(`${file}:${line}: forbidden dependency ${from} -> ${to}`);
    if (from !== "checks" && !modules[to].public.includes(target))
      errors.push(`${file}:${line}: private contract ${to}/${target}`);
  }

  for (const file of files) {
    const text = readFileSync(resolve(root, file), "utf8");
    contents.set(file, createHash("sha256").update(text).digest("hex"));
    if (!moduleOf(file)) errors.push(`Unassigned source: ${file}`);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let jsxRecorded = false;
    function visit(node) {
      // Automatic JSX imports must not smuggle React into pure data modules
      if (
        !jsxRecorded &&
        (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
      ) {
        record("react/jsx-runtime", file, source, node, "implicit-jsx");
        jsxRecorded = true;
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        record(
          node.moduleSpecifier.text,
          file,
          source,
          node,
          ts.isImportDeclaration(node) && node.importClause?.isTypeOnly ? "type" : "static",
        );
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal.text, file, source, node, "type-query");
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression.text, file, source, node, "require-type");
      } else if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || expression === "require") {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument))
            record(
              argument.text,
              file,
              source,
              node,
              expression === "require" ? "require" : "dynamic",
            );
          else {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            computedImports.push({ file, line, expression: argument?.getText(source) });
            // Browser test drivers select Playwright or Three.js from the test environment
            const playwright =
              file.startsWith("tests/") &&
              argument?.getText(source) ===
                'process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"';
            const browserThree =
              ["tests/editor-integration.check.mjs", "tests/caching.measure.mjs"].includes(file) &&
              ["threePath", "loaderPath"].includes(argument?.getText(source));
            const cacheProbe = file === "tests/caching.check.mjs";
            const probeExpression = argument?.getText(source).replace(/\s+/g, " ");
            const cacheThree =
              cacheProbe &&
              [
                'source.match(/import \\* as THREE from "([^"]+)"/)[1]',
                'cacheSource.match(/import \\{ GLTFLoader \\} from "([^"]+)"/)[1]',
              ].includes(probeExpression);
            const cacheModule = cacheProbe && probeExpression === "cachePath";
            if (playwright || browserThree)
              record(playwright ? "playwright" : "three", file, source, node, "test-environment");
            else if (cacheThree || cacheModule)
              record(
                cacheModule ? "../shared/assets/ModelCache.ts" : "three",
                file,
                source,
                node,
                "test-transformed-module",
              );
            else errors.push(`${file}:${line}: computed import cannot be checked`);
          }
        } else if (expression === "import.meta.glob" || expression === "import.meta.globEager") {
          errors.push(`${file}: import globs are not allowed; use explicit imports`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const reference of source.referencedFiles)
      record("./" + reference.fileName, file, source, source, "reference");
    for (const reference of source.typeReferenceDirectives)
      record(reference.fileName, file, source, source, "type-reference");
  }
  for (const file of new Set([
    "editor/index.html",
    ...imports
      .map((entry) => (typeof entry.target === "string" ? entry.target : ""))
      .filter((file) => file && !files.includes(file)),
  ])) {
    if (existsSync(resolve(root, file)))
      contents.set(
        file,
        createHash("sha256")
          .update(readFileSync(resolve(root, file)))
          .digest("hex"),
      );
  }

  const visiting = new Set();
  const visited = new Set();
  function visitModule(name, path) {
    if (visiting.has(name)) {
      errors.push(`Module cycle: ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of [...edges.get(name)].sort()) visitModule(dependency, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of Object.keys(modules)) visitModule(name, []);
  const graph = {
    modules,
    edges: Object.fromEntries([...edges].map(([name, uses]) => [name, [...uses].sort()])),
    files: Object.fromEntries(contents),
    imports,
    computedImports,
  };
  return { graph, errors };
}

export function dependents(name) {
  const affected = new Set([name]);
  let previous;
  do {
    previous = affected.size;
    for (const [consumer, rule] of Object.entries(modules)) {
      if (rule.uses.some((dependency) => affected.has(dependency))) affected.add(consumer);
    }
  } while (previous !== affected.size);
  affected.delete(name);
  return [...affected].sort();
}

function graphMarkdown(graph) {
  const nodes = Object.keys(modules).map((name) => `  ${name}["${name}"]`);
  const edges = Object.entries(graph.edges).flatMap(([from, dependencies]) =>
    dependencies.map((to) => `  ${from} --> ${to}`),
  );
  return `<!-- Generated by npm run graph:architecture; do not edit -->\n# Implemented import graph\n\nAn arrow means imports, including type-only and dynamic imports. Checks are consumer\ntests, including tests co-located with their implementation. Build is the existing\nVite/ESLint/Vitest configuration and architecture tooling.\n\n\`\`\`mermaid\ngraph TD\n${[...nodes, ...edges].join("\n")}\n\`\`\`\n\nFull file/line/import evidence and source hashes: [architecture-graph.json](architecture-graph.json).\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { graph, errors } = scan();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const outputs = new Map([
      [resolve(webRoot, "../docs/architecture-graph.json"), JSON.stringify(graph, null, 2) + "\n"],
      [resolve(webRoot, "../docs/architecture-graph.md"), graphMarkdown(graph)],
    ]);
    for (const [path, content] of outputs) {
      if (process.argv.includes("--write")) writeFileSync(path, content);
      else if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
        console.error(`Stale graph: ${relative(webRoot, path)}; run npm run graph:architecture`);
        process.exitCode = 1;
      }
    }
    if (!process.exitCode)
      console.log(
        `PASS: ${Object.keys(graph.files).length} source files, ${graph.imports.length} imports, no forbidden edges or module cycles; graph is current`,
      );
  }
}
