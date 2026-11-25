from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

from sharding import balance


HERE = Path(__file__).resolve().parent
ASSEMBLY = "tests/bin/Release/net10.0/Spatia.Server.Tests.dll"


def run(shard):
    tests = json.loads(subprocess.check_output(
        ["dotnet", ASSEMBLY, "--list-tests", "json", "--no-banner", "--no-ansi"],
        encoding="utf-8-sig",
    ))["tests"]
    groups = defaultdict(list)
    for test in tests:
        groups[test["type"]["typeName"]].append(test)
    ids = [test["uid"] for test in tests]
    if len(groups) < 2 or len(set(ids)) != len(ids):
        raise ValueError("Expected at least two test classes and unique discovered test UIDs")

    recorded = json.loads((HERE / "server-class-seconds.json").read_text())
    shards = balance({name: recorded.get(name, len(cases)) for name, cases in groups.items()}, 2)
    cases = [test for name in shards[shard - 1] for test in groups[name]]
    directory = Path("test-results/ci") / str(shard)
    directory.mkdir(parents=True, exist_ok=True)
    selector = directory / "selected.rsp"
    selector.write_text("--filter-uid\n" + "\n".join(json.dumps(test["uid"], ensure_ascii=False)
                                                    for test in cases) + "\n", encoding="utf-8")
    print(f"Shard {shard}: {len(cases)} of {len(tests)} cases in {len(shards[shard - 1])} classes", flush=True)
    subprocess.run([
        "dotnet", ASSEMBLY, "@" + str(selector.resolve()), "--no-banner", "--no-ansi",
        "--results-directory", str(directory.resolve()), "--report-trx", "--report-trx-filename", "server.trx",
        "--minimum-expected-tests", str(len(cases)), "--show-slowest-tests", "8",
    ], check=True)
    report = ET.parse(directory / "server.trx")
    classes = {node.attrib["id"]: node.find("{*}TestMethod").attrib["className"]
               for node in report.findall("./{*}TestDefinitions/{*}UnitTest")}
    observed = Counter()
    seconds = Counter()
    for node in report.findall("./{*}Results/{*}UnitTestResult"):
        if node.attrib["outcome"] != "Passed":
            raise ValueError(f"{node.attrib['testName']}: {node.attrib['outcome']}")
        class_name = classes[node.attrib["testId"]]
        observed[class_name, node.attrib["testName"]] += 1
        hours, minutes, fraction = node.attrib["duration"].split(":")
        seconds[class_name.rsplit(".", 1)[-1]] += int(hours) * 3600 + int(minutes) * 60 + float(fraction)
    expected = Counter((test["type"]["namespace"] + "." + test["type"]["typeName"], test["displayName"])
                       for test in cases)
    if observed != expected:
        raise ValueError(f"TRX inventory mismatch: missing {expected - observed}, extra {observed - expected}")
    (directory / "class-seconds.json").write_text(
        json.dumps({name: round(value, 2) for name, value in seconds.items()}, sort_keys=True, indent=2) + "\n"
    )
    partition = [sorted(test["uid"] for name in names for test in groups[name]) for names in shards]
    digest = hashlib.sha256(json.dumps(partition, ensure_ascii=False).encode()).hexdigest()
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as stream:
            print(f"inventory_{shard}={digest}", file=stream)
    print(f"Verified {len(cases)} cases; partition SHA-256 {digest}")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2"}:
        sys.exit("Usage from apps/server: python server_shard.py {1|2}")
    run(int(sys.argv[1]))
