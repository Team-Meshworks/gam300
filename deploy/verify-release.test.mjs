import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRelease } from "./verify-release.mjs";

const current = "a".repeat(40);
const run = {
  status: "completed",
  conclusion: "success",
  head_branch: "dev",
  workflow_id: 42,
  event: "push",
  head_sha: current,
};
test("accepts the tested current branch commit", () => {
  assert.deepEqual(verifyRelease(run, "dev", 42, current), {
    commit: current,
    environment: "development",
  });
});
test("rejects older successful artifacts that could invoke a legacy rollback script", () => {
  assert.throws(() =>
    verifyRelease({ ...run, head_sha: "b".repeat(40) }, "dev", 42, current),
  );
});
test("rejects failed, unrelated or pull-request CI runs", () => {
  for (const change of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_branch: "main" },
    { workflow_id: 43 },
    { event: "pull_request" },
  ]) {
    assert.throws(() =>
      verifyRelease({ ...run, ...change }, "dev", 42, current),
    );
  }
});
