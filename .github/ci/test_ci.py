import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from browser_matrix import changed_paths, plan
from server_shard import trx_display_name
from sharding import balance


class CiSelectionTests(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(TemporaryDirectory()))
        self.enterContext(patch("browser_matrix.ROOT", root))
        self.enterContext(patch("browser_matrix.HERE", root))
        self.web = root / "apps/web"
        for name in (
            "editor/example.tsx", "editor/example.test.ts", "editor/preview.html",
            "tests/preview.mjs", "tests/play.mjs", "tests/walk.mjs",
        ):
            path = self.web / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        catalog = {"preview": {"seconds": 1, "path": "/preview.html#panel"}, "player": {"seconds": 2}}
        scripts = {
            "test:preview": "node tests/preview.mjs",
            "test:player": "node tests/play.mjs && node tests/walk.mjs",
        }
        (root / "browser-checks.json").write_text(json.dumps(catalog), encoding="utf-8")
        (self.web / "package.json").write_text(json.dumps({"scripts": scripts}), encoding="utf-8")

    @staticmethod
    def checks(result):
        return [row for shard in result["browser"] for row in shard["checks"].splitlines()]

    def test_affected_drivers_keep_parameters_and_aggregate_commands(self):
        for path in ("apps/web/tests/preview.mjs", "apps/web/editor/preview.html"):
            self.assertEqual(self.checks(plan("pull_request", [path])), ["preview /preview.html#panel"])
        self.assertEqual(self.checks(plan("pull_request", ["apps/web/tests/walk.mjs"])), ["player"])

    def test_documentation_and_full_unit_changes_leave_expensive_pr_jobs_idle(self):
        result = plan("pull_request", ["docs/guide.md", "apps/web/editor/example.test.ts"])
        self.assertEqual(result, {"browser": [], "proof": False, "server": False,
                                  "unit_files": ["editor/example.test.ts"]})

    def test_csharp_test_edits_exercise_the_server_and_embedded_browser_suite(self):
        result = plan("pull_request", ["apps/server/tests/ExampleTests.cs"])
        self.assertEqual(result, {"browser": [], "proof": False, "server": True, "unit_files": []})

    def test_related_units_need_a_known_test_and_broader_prs_get_the_full_suite(self):
        module = "apps/web/editor/example.tsx"
        test = "apps/web/editor/example.test.ts"
        for changes in ([module], [test, module]):
            self.assertCountEqual(plan("pull_request", changes)["unit_files"],
                                  ["editor/example.tsx", "editor/example.test.ts"])
        for event, paths in [("push", [module]), ("pull_request", [module, "assets/manifest.json"]),
                             ("pull_request", ["apps/web/editor/deleted.ts"]), ("pull_request", None)]:
            self.assertEqual(plan(event, paths)["unit_files"], [])

        (self.web / "editor/example.test.ts").rename(self.web / "editor/moved.test.ts")
        for changes in ([module], [test, "apps/web/editor/moved.test.ts"]):
            self.assertEqual(plan("pull_request", changes)["unit_files"], [])

    def test_trx_escapes_the_nul_in_the_username_case_and_preserves_valid_unicode(self):
        self.assertEqual(trx_display_name("login(nul\0name)"), r"login(nul\u0000name)")
        self.assertEqual(trx_display_name("login(测试 🧪)"), "login(测试 🧪)")

    def test_uncertain_diffs_and_full_events_keep_all_fixtures(self):
        full = self.checks(plan("workflow_dispatch", None))
        self.assertEqual(len(set(full)), len(full))
        for event, paths in [
            ("pull_request", None), ("pull_request", ["assets/manifest.json"]),
            ("pull_request", ["apps/web/tests/browser-security.mjs"]),
            ("pull_request", ["apps/server/Spatia.Server/Program.cs"]),
            ("push", ["README.md"]), ("workflow_dispatch", ["README.md"]),
        ]:
            self.assertCountEqual(self.checks(plan(event, paths)), full)
        (self.web / "tests/walk.mjs").unlink()
        self.assertCountEqual(self.checks(plan("pull_request", ["apps/web/tests/walk.mjs"])), full)
        self.assertIsNone(changed_paths("0" * 40))

    def test_ties_and_discovery_order_do_not_change_partition(self):
        weights = {"big": 10, "medium": 6, "other": 4, "new": 1}
        shards = balance(weights, 2)
        self.assertEqual(shards, balance(dict(reversed(weights.items())), 2))
        self.assertCountEqual(sum(shards, []), weights.keys())
        self.assertEqual(sorted(sum(weights[name] for name in shard) for shard in shards), [10, 11])

    def test_serial_cases_are_spread_before_filling_by_total_class_time(self):
        weights = dict.fromkeys("abcdefghi", 10)
        serial = {"a": 9, "d": 9, "g": 9, "retired": 99}
        shards = balance(weights, 3, serial_seconds=serial)
        self.assertCountEqual(sum(shards, []), weights.keys())
        for shard in shards:
            self.assertEqual(sum(serial.get(name, 0) for name in shard), 9)
            self.assertEqual(sum(weights[name] for name in shard), 30)


if __name__ == "__main__":
    unittest.main()
