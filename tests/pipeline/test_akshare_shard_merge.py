from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from zoneinfo import ZoneInfo

from scripts.build_akshare_shard import select_shard_stocks
from scripts.build_akshare_snapshot import StockItem
from scripts.merge_akshare_shards import merge_shards, validate_shards
from scripts.prepare_akshare_context import calculate_context_hash


class ShardAssignmentTests(unittest.TestCase):
    def test_deterministic_shards_are_balanced_disjoint_and_complete(self) -> None:
        stocks = [StockItem(f"{index:06d}", f"股票{index}", "未分类") for index in range(23)]
        shards = [select_shard_stocks(stocks, index, 8) for index in range(8)]

        flattened = [stock.code for shard in shards for stock in shard]
        self.assertEqual(set(flattened), {stock.code for stock in stocks})
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertLessEqual(max(map(len, shards)) - min(map(len, shards)), 1)
        self.assertEqual(shards, [select_shard_stocks(list(reversed(stocks)), index, 8) for index in range(8)])


class ShardMergeTests(unittest.TestCase):
    def setUp(self) -> None:
        stable = {
            "version": 1,
            "shardCount": 2,
            "stocks": [
                {"code": f"{index:06d}", "name": f"股票{index}", "industry": "未分类"}
                for index in range(10)
            ],
            "stockCount": 10,
            "requiredHistoryCodeCount": 0,
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

    def make_shards(self, failed_codes: set[str] | None = None) -> list[dict]:
        failed_codes = failed_codes or {"000009"}
        stocks = [StockItem(**item) for item in self.context["stocks"]]
        shards = []
        for index in range(2):
            assigned = [stock.code for stock in select_shard_stocks(stocks, index, 2)]
            success = [code for code in assigned if code not in failed_codes]
            shards.append({
                "version": 1,
                "contextHash": self.context["contextHash"],
                "shardIndex": index,
                "shardCount": 2,
                "stockCount": len(assigned),
                "stockCodes": assigned,
                "historySuccessCount": len(success),
                "successCodes": success,
                "providerCounts": {"eastmoney": len(success)},
                "cacheHitCount": len(success),
                "failures": [
                    {"code": code, "name": code, "error": "unavailable"}
                    for code in assigned if code in failed_codes
                ],
                "dates": {
                    "2026-07-08": {
                        "rows": [],
                        "closes": {code: 10.0 for code in success},
                        "baselineCloses": {},
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
            )

            snapshot = json.loads((root / "latest.json").read_text(encoding="utf-8"))
            close = json.loads((root / "market-close.json").read_text(encoding="utf-8"))
            manifest = json.loads((root / "publish" / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(summary["historySuccessRate"], 0.9)
        self.assertEqual(summary["cacheHitCount"], 9)
        self.assertEqual(snapshot["meta"]["shardCount"], 2)
        self.assertEqual(snapshot["meta"]["exactCloseCoverage"], 0.9)
        self.assertEqual(close["missingCodes"], ["000009"])
        self.assertEqual(manifest["contextHash"], self.context["contextHash"])

    def test_merge_rejects_global_coverage_below_ninety_percent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(SystemExit):
                merge_shards(
                    self.context,
                    self.make_shards({"000008", "000009"}),
                    root / "latest.json",
                    root / "market-close.json",
                    root / "trading-calendar.json",
                    root / "publish",
                )

    def test_merge_requires_every_exact_shard(self) -> None:
        shards = self.make_shards()
        with self.assertRaisesRegex(ValueError, "Expected 2 shards"):
            validate_shards(self.context, shards[:1])


if __name__ == "__main__":
    unittest.main()
