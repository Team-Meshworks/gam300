import { spawnSync } from "node:child_process";
for (const test of [
  "admin-navigation-regression",
  "admin-classes-navigation",
  "admin-project-grants-navigation",
]) {
  const result = spawnSync(
    process.execPath,
    [`tests/${test}.check.mjs`, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
