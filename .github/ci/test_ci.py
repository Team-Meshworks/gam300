import unittest
from unittest.mock import patch

from browser_matrix import changed_paths, plan
from server_shard import trx_display_name
from sharding import balance


class CiSelectionTests(unittest.TestCase):
    @staticmethod
    def checks(result):
        return [row for shard in result["browser"] for row in shard["checks"].splitlines()]

    def test_affected_drivers_keep_parameters_and_aggregate_commands(self):
        result = plan("pull_request", [
            "apps/web/tests/assignment-screen.check.mjs",
            "apps/web/tests/player-walking.check.mjs",
            "apps/web/editor/ui-preview/assignment-test.html",
        ])
        self.assertCountEqual(self.checks(result), ["assignment-screen /ui-preview/assignment-test.html", "player-parity"])

    def test_documentation_and_full_unit_changes_leave_expensive_pr_jobs_idle(self):
        result = plan("pull_request", ["docs/deployment.md", "apps/web/editor/controls/fpsControls.test.ts"])
        self.assertEqual(result, {"browser": [], "proof": False, "server": False,
                                  "unit_files": ["editor/controls/fpsControls.test.ts"]})

    def test_csharp_test_edits_exercise_the_server_and_embedded_browser_suite(self):
        result = plan("pull_request", ["apps/server/tests/Integration/ProductionRoomBrowserTests.cs"])
        self.assertEqual(result, {"browser": [], "proof": False, "server": True, "unit_files": []})

    def test_related_units_need_a_known_test_and_broader_prs_get_the_full_suite(self):
        module = "apps/web/editor/controls/fpsControls.ts"
        self.assertEqual(plan("pull_request", [module])["unit_files"], ["editor/controls/fpsControls.ts"])
        for event, paths in [("push", [module]), ("pull_request", [module, "assets/manifest.json"]),
                             ("pull_request", ["apps/web/editor/deleted.ts"]), ("pull_request", None)]:
            self.assertEqual(plan(event, paths)["unit_files"], [])

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
        with patch("browser_matrix.Path.is_file", return_value=False):
            self.assertCountEqual(self.checks(plan("pull_request", ["apps/web/tests/assignment-screen.check.mjs"])), full)
        self.assertIsNone(changed_paths("0" * 40))

    def test_ties_and_discovery_order_do_not_change_partition(self):
        weights = {"big": 10, "medium": 6, "other": 4, "new": 1}
        shards = balance(weights, 2)
        self.assertEqual(shards, balance(dict(reversed(weights.items())), 2))
        self.assertCountEqual(sum(shards, []), weights.keys())
        self.assertEqual(sorted(sum(weights[name] for name in shard) for shard in shards), [10, 11])


if __name__ == "__main__":
    unittest.main()
