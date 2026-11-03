import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Resolve fixtures relative to this script so local and CI runs use the same asset registry
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures = new URL("../shared/project/fixtures/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const manifest = read("project-format-cases.json");
const kinds = new Map(Object.entries(manifest.assets));

// Load the production TypeScript readers directly without maintaining a JavaScript copy
const modules = await createServer({
  configFile: false,
  root: webRoot,
  server: { middlewareMode: true },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { deserializeProject } = await modules.ssrLoadModule(
    "/shared/project/project-deserialization.ts",
  );
  const { serializeProject } = await modules.ssrLoadModule(
    "/shared/project/project-serialization.ts",
  );

  // Exercise released examples, storage text and every URL case from the shared corpus
  const cases = manifest.cases.filter(
    (test) =>
      test.patches.length === 0 ||
      test.name.startsWith("storage NUL") ||
      /^v[12] interaction URL/.test(test.name) ||
      (test.patches.length === 1 && test.patches[0].path.at(-1) === "url"),
  );

  // Start each patch from fresh JSON so one malformed host cannot contaminate another case
  const inputs = cases.map((test) => {
    const document = read(test.base + "-project.json");
    for (const patch of test.patches) {
      let parent = document;
      for (const segment of patch.path.slice(0, -1)) {
        parent = parent[segment];
      }
      const repeated = patch.repeat;
      const value =
        repeated === undefined
          ? patch.value
          : typeof patch.value === "string"
            ? patch.value.repeat(repeated)
            : Array.from({ length: repeated }, () => structuredClone(patch.value));
      parent[patch.path.at(-1)] = value;
    }
    return JSON.stringify(document);
  });

  // Rejected inputs have no writer output; accepted inputs must survive the real browser serializer
  const browser = inputs.map((input, index) => {
    const result = deserializeProject(input, kinds);
    assert.equal(result.ok, cases[index].valid, cases[index].name + ": browser acceptance");
    if (!result.ok) {
      return null;
    }
    const saved = serializeProject(result.value, kinds);
    assert.ok(saved.ok, cases[index].name + ": browser writing");
    return saved.value;
  });

  // Send original inputs AND the browser writer's actual bytes through the built C# reader/writer
  const peerInputs = [...inputs, ...browser.filter((output) => output !== null)];

  // CI builds Release during the shared fixture check before invoking this exchange mode
  // Keep stdout exclusively JSON and bound the child process so a failure cannot hang the job
  const server = spawnSync(
    "dotnet",
    [
      "run",
      "--no-build",
      "--project",
      fileURLToPath(
        new URL(
          "../../server/project-format-checks/Spatia.ProjectFormat.Checks.csproj",
          import.meta.url,
        ),
      ),
      "-c",
      "Release",
      "--",
      "--exchange",
    ],
    {
      input: JSON.stringify(peerInputs),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );

  // Distinguish process failures from format failures before interpreting the peer response
  assert.ifError(server.error);
  assert.equal(server.status, 0, server.stderr || server.stdout);
  const outputs = JSON.parse(server.stdout);
  assert.equal(outputs.length, peerInputs.length);

  // The first segment retains fixture expectations; every appended browser output must be accepted
  outputs.forEach((output, index) => {
    const expected = index < cases.length ? cases[index].valid : true;
    assert.equal(output.ok, expected, `C# acceptance for exchange ${index}: ${output.path}`);
    if (output.ok) {
      // Reopen actual C# output, including documents the server first received from the browser writer
      const reopened = deserializeProject(output.json, kinds);
      assert.ok(reopened.ok, `Browser reopening C# output ${index}`);

      // A successful reopen must also retain the original escaped or Unicode URL spelling
      const source = JSON.parse(peerInputs[index]);
      if (source.schemaVersion === 2) {
        assert.equal(
          reopened.value.scenes[0].rules[5].actions[0].url,
          source.scenes[0].rules[5].actions[0].url,
          "Cross-runtime writing preserves the authored URL",
        );
      }
    }
  });
  console.log(`PASS: ${cases.length} shared cases exchanged in both writer/reader directions`);
} finally {
  // Release Vite watchers even when an assertion fails so the test process can exit
  await modules.close();
}
