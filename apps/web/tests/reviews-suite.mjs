import { spawnSync } from "node:child_process";
for (const test of ["review-workflow", "review-exit-publish"]) {
  const result = spawnSync(
    process.execPath,
    [`tests/${test}.check.mjs`, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
