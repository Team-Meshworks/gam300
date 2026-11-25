import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess

from sharding import balance


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROOF_PATHS = (
    "apps/web/architecture.mjs", "apps/web/architecture.check.mjs",
    "apps/web/tsconfig*.json", "apps/web/package*.json", "apps/web/*config*",
    ".github/workflows/ci.yml", ".github/ci/*",
)


def changed_paths(base):
    if not re.fullmatch(r"[0-9a-f]{40}", base) or not base.strip("0"):
        return None
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"],
        cwd=ROOT, capture_output=True,
    )
    if result.returncode:
        return None
    return [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]


def documentation(path):
    return path == "README.md" or (path.startswith("docs/") and path.endswith(".md"))


def unit_test(path):
    return path.startswith(("apps/web/editor/", "apps/web/shared/", "apps/web/visitor/")) and path.endswith(".test.ts")


def browser_checks(catalog, scripts, changes):
    if changes is None:
        return set(catalog)
    owners = {}
    for name, check in catalog.items():
        for entry in re.findall(r"\btests/[\w./-]+\.mjs\b", scripts["test:" + name]):
            owners.setdefault("apps/web/" + entry, set()).add(name)
        if check.get("path"):
            route = check["path"].split("#")[0]
            owners.setdefault("apps/web/editor" + route, set()).add(name)

    selected = set()
    for path in changes:
        if documentation(path) or unit_test(path):
            continue
        if path not in owners or not (ROOT / path).is_file():
            return set(catalog)
        selected.update(owners[path])
    return selected


def plan(event, changes):
    catalog = json.loads((HERE / "browser-checks.json").read_text())
    scripts = json.loads((ROOT / "apps/web/package.json").read_text())["scripts"]
    selected = browser_checks(catalog, scripts, changes if event == "pull_request" else None)
    shards = balance({name: catalog[name]["seconds"] for name in selected}, 6)
    matrix = [
        {"name": str(i), "checks": "\n".join(
            (name + " " + catalog[name].get("path", "")).rstrip() for name in shard
        )}
        for i, shard in enumerate(shards, 1)
    ]
    proof = event == "workflow_dispatch" or changes is None or any(
        fnmatch.fnmatchcase(path, pattern) for path in changes for pattern in PROOF_PATHS
    )
    server = event != "pull_request" or changes is None or any(
        not documentation(path) and not unit_test(path) for path in changes
    )
    return {"browser": matrix, "proof": proof, "server": server}


if __name__ == "__main__":
    result = plan(os.environ["EVENT_NAME"], changed_paths(os.environ.get("BASE_SHA", "")))
    print(json.dumps(result, indent=2))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for name, value in result.items():
            print(f"{name}={json.dumps(value, separators=(',', ':'))}", file=output)
