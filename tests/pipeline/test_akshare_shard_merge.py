from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from zoneinfo import ZoneInfo

from scripts.build_akshare_shard import SHARD_VERSION, select_shard_stocks
from scripts.build_akshare_snapshot import StockItem
from scripts.merge_akshare_shards import merge_shards, validate_context_universe, validate_shards
from scripts.prepare_akshare_context import calculate_context_hash
from scripts.universe_manifest import reconcile_universe_manifest


class ShardAssignmentTests(unittest.TestCase):
    def test_deterministic_shards_are_balanced_disjoint_and_complete(self) -> None:
        stocks = [StockItem(f"{index:06d}", f"股票{index}", "未分类") for index in range(23)]
        shards = [select_shard_stocks(stocks, index, 8) for index in range(8)]

        flattened = [stock.code for shard in shards for stock in shard]
        self.assertEqual(set(flattened), {stock.code for stock in stocks})
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertLessEqual(max(map(len, shards)) - min(map(len, shards)), 1)
        self.assertEqual(shards, [select_shard_stocks(list(reversed(stocks)), index, 8) for index in range(8)])

    def test_existing_codes_do_not_move_when_a_listing_is_inserted(self) -> None:
        original = [StockItem(code, code, "未分类") for code in ["000001", "000010", "000021", "600000"]]
        expanded = [*original, StockItem("000005", "新增", "未分类")]
        original_assignment = {
            stock.code: shard
            for shard in range(8)
            for stock in select_shard_stocks(original, shard, 8)
        }
        expanded_assignment = {
            stock.code: shard
            for shard in range(8)
            for stock in select_shard_stocks(expanded, shard, 8)
        }

        self.assertEqual(
            original_assignment,
            {code: expanded_assignment[code] for code in original_assignment},
        )


class ShardMergeTests(unittest.TestCase):
    def setUp(self) -> None:
        stock_items = [
            StockItem(f"{index:06d}", f"股票{index}", "未分类")
            for index in range(50)
        ]
        self.universe = reconcile_universe_manifest(
            stock_items,
            "code-list",
            datetime(2026, 7, 8, 15, 55, tzinfo=ZoneInfo("Asia/Shanghai")),
        )
        stable = {
            "version": 1,
            "shardCount": 2,
            "stocks": [
                {"code": f"{index:06d}", "name": f"股票{index}", "industry": "未分类"}
                for index in range(50)
            ],
            "stockCount": 50,
            "requiredHistoryCodeCount": 0,
            "requiredOnlyCodes": [],
            "universeManifestRevision": self.universe["revision"],
            "universeManifestMemberCount": 50,
            "universeStaleCount": 0,
            "universeStaleCodes": [],
            "requestedUniverseSource": "code-list",
            "universeSource": "code-list",
            "limit": 0,
            "perBoard": 0,
            "buildMode": "production",
            "historySource": "eastmoney",
            "adjust": "qfq",
            "skipIndustryMap": True,
            "maxWorkers": 1,
            "sleep": 0.08,
            "requestTimeout": 20.0,
            "allowProviderFallback": False,
            "startDate": "20260101",
            "endDate": "20260708",
            "targets": ["2026-07-08"],
            "targetSources": {"2026-07-08": "live"},
            "calendar": {"version": 1, "tradingDates": ["2026-07-08", "2026-07-09"]},
        }
        self.context = {
            **stable,
            "contextHash": calculate_context_hash(stable),
            "preparedAt": "2026-07-08T16:00:00+08:00",
        }

    def make_shards(
        self,
        failed_codes: set[str] | None = None,
        not_listed_codes: set[str] | None = None,
        suspended_codes: set[str] | None = None,
    ) -> list[dict]:
        failed_codes = {"000049"} if failed_codes is None else failed_codes
        not_listed_codes = not_listed_codes or set()
        suspended_codes = suspended_codes or set()
        stocks = [StockItem(**item) for item in self.context["stocks"]]
        shards = []
        for index in range(2):
            assigned = [stock.code for stock in select_shard_stocks(stocks, index, 2)]
            success = [code for code in assigned if code not in failed_codes]
            shards.append({
                "version": SHARD_VERSION,
                "contextHash": self.context["contextHash"],
                "shardIndex": index,
                "shardCount": 2,
                "stockCount": len(assigned),
                "stockCodes": assigned,
                "historySuccessCount": len(success),
                "successCodes": success,
                "providerCounts": {"eastmoney": len(success)},
                "cacheHitCount": len(success),
                "cacheFullHitCount": len(success),
                "cacheIncrementalHitCount": 0,
                "cacheRefreshCount": 0,
                "failures": [
                    {"code": code, "name": code, "error": "unavailable"}
                    for code in assigned if code in failed_codes
                ],
                "dates": {
                    "2026-07-08": {
                        "rows": [],
                        "closes": {
                            code: 10.0
                            for code in success
                            if code not in not_listed_codes and code not in suspended_codes
                        },
                        "baselineCloses": {},
                        "notListedCodes": sorted(set(assigned).intersection(not_listed_codes)),
                        "suspendedCodes": sorted(set(assigned).intersection(suspended_codes)),
                    }
                },
                "finishedAt": "2026-07-08T16:05:00+08:00",
            })
        return shards

    def test_merge_enforces_global_coverage_and_writes_publish_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = merge_shards(
                self.context,
                self.make_shards(),
                root / "latest.json",
                root / "market-close.json",
                root / "trading-calendar.json",
                root / "publish",
                datetime(2026, 7, 8, 16, tzinfo=ZoneInfo("Asia/Shanghai")),
                universe_manifest=self.universe,
            )

            snapshot = json.loads((root / "latest.json").read_text(encoding="utf-8"))
            close = json.loads((root / "market-close.json").read_text(encoding="utf-8"))
            manifest = json.loads((root / "publish" / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(summary["historySuccessRate"], 0.98)
        self.assertEqual(summary["cacheHitCount"], 49)
        self.assertEqual(snapshot["meta"]["shardCount"], 2)
        self.assertEqual(snapshot["meta"]["exactCloseCoverage"], 0.98)
        self.assertEqual(close["missingCodes"], ["000049"])
        self.assertEqual(close["providerMissingCodes"], ["000049"])
        self.assertEqual(close["notListedCodes"], [])
        self.assertEqual(close["suspendedCodes"], [])
        self.assertEqual(manifest["contextHash"], self.context["contextHash"])
        self.assertEqual(manifest["universeManifestRevision"], self.universe["revision"])

    def test_merge_rejects_history_coverage_below_ninety_eight_percent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(SystemExit):
                merge_shards(
                    self.context,
                    self.make_shards({"000048", "000049"}),
                    root / "latest.json",
                    root / "market-close.json",
                    root / "trading-calendar.json",
                    root / "publish",
                )

    def test_merge_preserves_not_listed_and_suspension_semantics_at_ninety_percent_close_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            summary = merge_shards(
                self.context,
                self.make_shards(
                    failed_codes=set(),
                    not_listed_codes={"000045", "000046"},
                    suspended_codes={"000047", "000048", "000049"},
                ),
                root / "latest.json",
                root / "market-close.json",
                root / "trading-calendar.json",
                root / "publish",
            )
            close = json.loads((root / "market-close.json").read_text(encoding="utf-8"))

        self.assertEqual(summary["historySuccessRate"], 1.0)
        self.assertEqual(summary["dates"][0]["closeCoverage"], 0.9)
        self.assertEqual(close["providerMissingCodes"], [])
        self.assertEqual(close["notListedCodes"], ["000045", "000046"])
        self.assertEqual(close["suspendedCodes"], ["000047", "000048", "000049"])

    def test_merge_requires_every_exact_shard(self) -> None:
        shards = self.make_shards()
        with self.assertRaisesRegex(ValueError, "Expected 2 shards"):
            validate_shards(self.context, shards[:1])

    def test_context_rejects_a_different_universe_revision(self) -> None:
        mismatched = {**self.universe, "revision": "0" * 16}
        with self.assertRaisesRegex(ValueError, "revision"):
            validate_context_universe(self.context, mismatched)


if __name__ == "__main__":
    unittest.main()
