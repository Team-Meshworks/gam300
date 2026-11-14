import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// These are implemented source boundaries, not the future server/player layout
export const modules = {
  network: {
    paths: ["shared/network/"],
    uses: [],
    packages: [],
    public: ["shared/network/abort-signals.ts"],
  },
  visitor: {
    paths: ["visitor/"],
    uses: ["project", "catalogue", "asset-loading", "network", "preview"],
    packages: ["react", "react-dom", "three"],
    public: [],
  },
  project: {
    paths: ["shared/project/"],
    uses: [],
    packages: ["punycode"],
    public: [
      "shared/project/project-types.ts",
      "shared/project/attached-transforms.ts",
      "shared/project/starting-view.ts",
      "shared/project/legacy-scene-import.ts",
      "shared/project/project-content.ts",
      "shared/project/project-appearance.ts",
      "shared/project/room-placement.ts",
      "shared/project/room-bounds.ts",
      "shared/project/selection-transform.ts",
      "shared/project/project-capabilities.ts",
      "shared/project/publication-capabilities.json",
      "shared/project/scene-object.ts",
      "shared/project/spatial-validation.ts",
      "shared/project/project-validation.ts",
      "shared/project/project-structure-validation.ts",
      "shared/project/project-serialization.ts",
      "shared/project/project-deserialization.ts",
      "shared/project/project-limits.ts",
      "shared/project/portable-url.ts",
      "shared/project/validation-helpers.ts",
      "shared/project/fixtures/m1-project.json",
      "shared/project/fixtures/m2-project.json",
      "shared/project/fixtures/m2-publication-project.json",
      "shared/project/fixtures/project-format-cases.json",
    ],
  },
  catalogue: {
    paths: ["shared/asset-runtime/"],
    uses: [],
    packages: [],
    public: ["shared/asset-runtime/catalogue.ts", "shared/asset-runtime/hotspot.ts"],
  },
  "asset-loading": {
    paths: [
      "shared/asset-runtime/ModelCache.ts",
      "shared/asset-runtime/room-entrances.ts",
      "shared/asset-runtime/exhibit-appearance.ts",
      "shared/asset-runtime/text-texture.ts",
      "shared/asset-runtime/display-layout.ts",
    ],
    uses: ["catalogue", "network", "project"],
    packages: ["three"],
    public: [
      "shared/asset-runtime/ModelCache.ts",
      "shared/asset-runtime/room-entrances.ts",
      "shared/asset-runtime/exhibit-appearance.ts",
      "shared/asset-runtime/text-texture.ts",
      "shared/asset-runtime/display-layout.ts",
    ],
  },
  preview: {
    paths: ["shared/preview/"],
    uses: [],
    packages: ["react", "three"],
    public: [
      "shared/preview/FpsControls.ts",
      "shared/preview/preview-start.ts",
      "shared/preview/MobileControls.tsx",
      "shared/preview/preview.css",
    ],
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
    uses: ["project", "catalogue", "asset-loading", "preview"],
    packages: ["three"],
    public: [
      "editor/graphics/scene.ts",
      "editor/graphics/modeManager.ts",
      "editor/graphics/library-previews.ts",
      "editor/graphics/project-panorama.ts",
    ],
  },
  persistence: {
    paths: ["editor/persistence/"],
    uses: ["project", "catalogue", "document", "network"],
    packages: ["react"],
    public: [
      "editor/persistence/server-project-session.ts",
      "editor/persistence/server-project-read.ts",
      "editor/persistence/server-assets.ts",
      "editor/persistence/recovery-session.ts",
      "editor/persistence/project-files.ts",
    ],
  },
  "ui-foundation": {
    paths: ["shared/ui/"],
    uses: [],
    packages: [
      "react",
      "@fortawesome/react-fontawesome",
      "@fortawesome/free-solid-svg-icons",
      "@iconify/react",
      "@iconify-icons/lucide",
    ],
    public: [
      "shared/ui/Button.tsx",
      "shared/ui/Select.tsx",
      "shared/ui/Field.tsx",
      "shared/ui/Avatar.tsx",
      "shared/ui/Tabs.tsx",
      "shared/ui/Dialog.tsx",
      "shared/ui/useModal.ts",
      "shared/ui/PageState.tsx",
      "shared/ui/SearchField.tsx",
      "shared/ui/Table.tsx",
      "shared/ui/WorkspaceShell.tsx",
      "shared/ui/assets/facilitator-ambient-top.svg",
      "shared/ui/assets/facilitator-ambient-bottom.svg",
      "shared/ui/WorkspaceHeader.tsx",
      "shared/ui/foundation.css",
    ],
  },
  editor: {
    paths: ["editor/"],
    uses: [
      "project",
      "catalogue",
      "input",
      "document",
      "rendering",
      "preview",
      "persistence",
      "ui-foundation",
      "network",
    ],
    packages: [
      "react",
      "react-dom",
      "@fortawesome/react-fontawesome",
      "@fortawesome/fontawesome-svg-core",
      "@fortawesome/free-solid-svg-icons",
      "@fontsource/inter",
      "@iconify/react",
      "@iconify-icons/ant-design",
      "@iconify-icons/bi",
      "@iconify-icons/bytesize",
      "@iconify-icons/lucide",
      "skullet",
      "qrcode.react",
      "jsqr",
    ],
    public: [],
  },
  build: { paths: [], uses: [], public: [] },
  checks: {
    paths: ["tests/"],
    uses: [
      "visitor",
      "project",
      "catalogue",
      "input",
      "document",
      "asset-loading",
      "rendering",
      "persistence",
      "editor",
      "ui-foundation",
      "network",
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
  if (modules["asset-loading"].paths.includes(file)) return "asset-loading";
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
      return "shared/asset-runtime/catalogue.ts";
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
              [
                "tests/editor-integration.check.mjs",
                "tests/interaction-navigation.check.mjs",
                "tests/caching.measure.mjs",
              ].includes(file) && ["threePath", "loaderPath"].includes(argument?.getText(source));
            const cacheProbe = file === "tests/caching.check.mjs";
            const hotspotProbe = [
              "tests/hotspot-placement.check.mjs",
              "tests/hotspot-rendering.check.mjs",
            ].includes(file);
            const probeExpression = argument?.getText(source).replace(/\s+/g, " ");
            const cacheThree =
              (cacheProbe || hotspotProbe) &&
              [
                'source.match(/import \\* as THREE from "([^"]+)"/)[1]',
                'cacheSource.match(/import \\{ GLTFLoader \\} from "([^"]+)"/)[1]',
              ].includes(probeExpression);
            const cacheModule = cacheProbe && probeExpression === "cachePath";
            const hotspotModule =
              file === "tests/hotspot-rendering.check.mjs" && probeExpression === "hotspotPath";
            if (playwright || browserThree)
              record(playwright ? "playwright" : "three", file, source, node, "test-environment");
            else if (cacheThree || cacheModule || hotspotModule)
              record(
                cacheModule
                  ? "../shared/asset-runtime/ModelCache.ts"
                  : hotspotModule
                    ? "../shared/asset-runtime/hotspot.ts"
                    : "three",
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
  return `<!-- Generated by npm run graph:architecture; do not edit -->\n# Implemented import graph\n\nAn arrow means imports, including type-only and dynamic imports. Checks are consumer\ntests, including tests co-located with their implementation. Build is the existing\nVite/Oxlint/Vitest configuration and architecture tooling.\n\n\`\`\`mermaid\ngraph TD\n${[...nodes, ...edges].join("\n")}\n\`\`\`\n\nFull file/line/import evidence and source hashes: [architecture-graph.json](architecture-graph.json).\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { graph, errors } = scan();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    // Validate live dependencies on every run; source hashes and line numbers are generated evidence
    // Comment-only changes must not fail architecture enforcement for leaving that evidence stale
    const outputs = new Map([
      [
        resolve(webRoot, "../../docs/architecture-graph.json"),
        JSON.stringify(graph, null, 2) + "\n",
      ],
      [resolve(webRoot, "../../docs/architecture-graph.md"), graphMarkdown(graph)],
    ]);
    for (const [path, content] of outputs) {
      if (process.argv.includes("--write")) writeFileSync(path, content);
    }
    if (!process.exitCode)
      console.log(
        `PASS: ${Object.keys(graph.files).length} source files, ${graph.imports.length} imports, no forbidden edges or module cycles`,
      );
  }
}
