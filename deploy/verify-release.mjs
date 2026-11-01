import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function verifyRelease(run, branch, workflow, commit) {
  if (
    !["main", "dev"].includes(branch) ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== branch ||
    run.workflow_id !== Number(workflow) ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    !/^[a-f0-9]{40}$/.test(commit ?? "") ||
    run.head_sha !== commit
  ) {
    throw new Error(
      "Deployment requires successful CI for the selected branch and current commit",
    );
  }
  return {
    commit: run.head_sha,
    environment: branch === "main" ? "production" : "development",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , path, branch, workflow, commit] = process.argv;
  verifyRelease(
    JSON.parse(readFileSync(path, "utf8")),
    branch,
    workflow,
    commit,
  );
}
