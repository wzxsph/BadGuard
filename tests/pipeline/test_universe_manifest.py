from __future__ import annotations

from datetime import datetime
import unittest
from zoneinfo import ZoneInfo

from scripts.build_akshare_snapshot import StockItem
from scripts.universe_manifest import (
    DEFAULT_MAX_UNIVERSE_DELTA_RATE,
    reconcile_universe_manifest,
    validate_universe_manifest,
)


class StickyUniverseManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.first_time = datetime(2026, 7, 9, 16, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.next_time = datetime(2026, 7, 10, 16, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.stocks = [
            StockItem(f"{index:06d}", f"股票{index}", "未分类")
            for index in range(100)
        ]
        self.prior = reconcile_universe_manifest(self.stocks, "code-list", self.first_time)

    def test_default_delta_threshold_is_one_percent(self) -> None:
        self.assertEqual(DEFAULT_MAX_UNIVERSE_DELTA_RATE, 0.01)

    def test_one_percent_missing_is_retained_and_marked_stale(self) -> None:
        proposed = reconcile_universe_manifest(
            self.stocks[:-1],
            "code-list",
            self.next_time,
            self.prior,
        )

        stale = next(member for member in proposed["members"] if member["code"] == "000099")
        self.assertEqual(proposed["memberCount"], 100)
        self.assertEqual(proposed["activeCount"], 99)
        self.assertEqual(proposed["staleCount"], 1)
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(proposed["delta"]["newlyMissingCodes"], ["000099"])
        self.assertEqual(proposed["delta"]["missingRate"], 0.01)

    def test_more_than_one_percent_missing_or_added_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "exceeds the accepted threshold"):
            reconcile_universe_manifest(self.stocks[:-2], "code-list", self.next_time, self.prior)

        additions = [
            *self.stocks,
            StockItem("100000", "新增1", "未分类"),
            StockItem("100001", "新增2", "未分类"),
        ]
        with self.assertRaisesRegex(ValueError, "exceeds the accepted threshold"):
            reconcile_universe_manifest(additions, "code-list", self.next_time, self.prior)

    def test_threshold_is_explicitly_configurable(self) -> None:
        proposed = reconcile_universe_manifest(
            self.stocks[:-2],
            "code-list",
            self.next_time,
            self.prior,
            maximum_delta_rate=0.02,
        )
        self.assertEqual(proposed["staleCount"], 2)
        self.assertEqual(proposed["delta"]["maximumDeltaRate"], 0.02)

    def test_small_addition_is_accepted_and_existing_stale_does_not_recount(self) -> None:
        one_stale = reconcile_universe_manifest(self.stocks[:-1], "code-list", self.next_time, self.prior)
        later = reconcile_universe_manifest(
            [*self.stocks[:-1], StockItem("100000", "新增", "未分类")],
            "code-list",
            datetime(2026, 7, 13, 16, tzinfo=ZoneInfo("Asia/Shanghai")),
            one_stale,
        )

        self.assertEqual(later["memberCount"], 101)
        self.assertEqual(later["staleCount"], 1)
        self.assertEqual(later["delta"]["addedCodes"], ["100000"])
        self.assertEqual(later["delta"]["newlyMissingCodes"], [])
        self.assertEqual(later["delta"]["stillStaleCodes"], ["000099"])

    def test_reappearing_stale_member_is_reactivated(self) -> None:
        one_stale = reconcile_universe_manifest(self.stocks[:-1], "code-list", self.next_time, self.prior)
        restored = reconcile_universe_manifest(
            self.stocks,
            "code-list",
            datetime(2026, 7, 13, 16, tzinfo=ZoneInfo("Asia/Shanghai")),
            one_stale,
        )

        member = next(member for member in restored["members"] if member["code"] == "000099")
        self.assertEqual(member["status"], "active")
        self.assertNotIn("staleSinceAt", member)
        self.assertEqual(restored["delta"]["reactivatedCodes"], ["000099"])

    def test_unchanged_effective_pool_reuses_exact_accepted_manifest(self) -> None:
        unchanged = reconcile_universe_manifest(self.stocks, "code-list", self.next_time, self.prior)
        self.assertEqual(unchanged, self.prior)

    def test_tampered_manifest_revision_is_rejected(self) -> None:
        tampered = {**self.prior, "members": [dict(member) for member in self.prior["members"]]}
        tampered["members"][0]["name"] = "篡改"
        with self.assertRaisesRegex(ValueError, "revision"):
            validate_universe_manifest(tampered)


if __name__ == "__main__":
    unittest.main()
