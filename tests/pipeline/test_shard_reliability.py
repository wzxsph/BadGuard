from __future__ import annotations

import io
import gzip
import json
import tempfile
import unittest
from collections import Counter
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import requests

from scripts.build_akshare_shard import (
    fetch_shard_histories,
    fetch_shard_histories_with_retries,
    history_cache_metadata,
    history_cache_path,
    load_or_fetch_history,
    order_retry_stocks,
    read_history_cache,
    read_history_cache_entry,
    write_history_cache,
)
from scripts.build_akshare_snapshot import (
    StockHistory,
    StockItem,
    exact_close,
    fetch_eastmoney_history,
    fetch_history,
)
from scripts.http_timeout import install_default_requests_timeout


def make_bars(prices: dict[str, float]) -> pd.DataFrame:
    return pd.DataFrame([
        {
            "date": date,
            "open": close,
            "close": close,
            "high": close + 0.1,
            "low": close - 0.1,
            "volume": 1_000_000,
            "amount": 300_000_000,
            "turnover_rate": 1.5,
            "float_market_cap": 8_000_000_000,
        }
        for date, close in prices.items()
    ])


class RetryOrderingTests(unittest.TestCase):
    def test_context_hash_spreads_code_families_deterministically(self) -> None:
        stocks = [StockItem(f"920{index:03d}", f"测试{index}", "测试") for index in range(20)]

        first = order_retry_stocks(stocks, {"contextHash": "stable-context"}, 0)
        repeated = order_retry_stocks(list(reversed(stocks)), {"contextHash": "stable-context"}, 0)
        next_round = order_retry_stocks(stocks, {"contextHash": "stable-context"}, 1)

        self.assertEqual([stock.code for stock in first], [stock.code for stock in repeated])
        self.assertNotEqual([stock.code for stock in first], [stock.code for stock in stocks])
        self.assertNotEqual([stock.code for stock in first], [stock.code for stock in next_round])


class ProviderTimeoutTests(unittest.TestCase):
    def test_eastmoney_timeout_is_forwarded_to_akshare(self) -> None:
        frame = pd.DataFrame([{"date": "2026-07-10"}])

        with patch("scripts.build_akshare_snapshot.ak.stock_zh_a_hist", return_value=frame) as fetch:
            result = fetch_eastmoney_history(
                "000001",
                "20260101",
                "20260710",
                "qfq",
                request_timeout=7.5,
            )

        self.assertIs(result, frame)
        self.assertEqual(fetch.call_args.kwargs["timeout"], 7.5)

    def test_eastmoney_attempt_limit_is_forwarded_to_retry_guard(self) -> None:
        with (
            patch(
                "scripts.build_akshare_snapshot.ak.stock_zh_a_hist",
                side_effect=requests.Timeout("provider timed out"),
            ) as fetch,
            patch("scripts.build_akshare_snapshot.time.sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "failed after 2 attempts"):
                fetch_eastmoney_history(
                    "000001",
                    "20260101",
                    "20260710",
                    "qfq",
                    request_timeout=7.5,
                    request_attempts=2,
                )

        self.assertEqual(fetch.call_count, 2)

    def test_default_requests_timeout_preserves_explicit_values(self) -> None:
        original_request = requests.sessions.Session.request
        calls: list[object] = []

        def fake_request(_session, _method, _url, **kwargs):
            calls.append(kwargs.get("timeout"))
            return object()

        requests.sessions.Session.request = fake_request
        try:
            install_default_requests_timeout(12.0)
            session = requests.Session()
            session.request("GET", "https://example.test/default")
            session.request("GET", "https://example.test/explicit", timeout=3.0)
        finally:
            requests.sessions.Session.request = original_request

        self.assertEqual(calls, [12.0, 3.0])

    def test_disabled_provider_fallback_never_calls_sina(self) -> None:
        stock = StockItem("000001", "测试", "银行")

        with (
            patch(
                "scripts.build_akshare_snapshot.fetch_eastmoney_history",
                side_effect=RuntimeError("eastmoney unavailable"),
            ),
            patch("scripts.build_akshare_snapshot.fetch_sina_history") as sina,
        ):
            with self.assertRaisesRegex(RuntimeError, "eastmoney unavailable"):
                fetch_history(
                    stock,
                    "20260101",
                    "20260710",
                    "qfq",
                    "eastmoney",
                    request_timeout=5.0,
                    allow_provider_fallback=False,
                )

        sina.assert_not_called()


class HistoryCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stock = StockItem("000001", "测试", "银行")
        self.context = {
            "startDate": "20260101",
            "endDate": "20260710",
            "adjust": "qfq",
            "historySource": "eastmoney",
            "allowProviderFallback": False,
        }
        self.bars = pd.DataFrame(
            [{
                "date": "2026-07-10",
                "open": 10.0,
                "close": 10.1,
                "high": 10.2,
                "low": 9.9,
                "volume": 1_000_000,
                "amount": 300_000_000,
                "turnover_rate": 1.5,
                "float_market_cap": 8_000_000_000,
            }]
        )

    def test_cache_round_trip_and_identity_is_stable_across_dates(self) -> None:
        metadata = history_cache_metadata(self.stock, self.context)
        changed_context = {**self.context, "endDate": "20260713"}
        changed_adjust = {**self.context, "adjust": "hfq"}

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(path, metadata, StockHistory(self.stock, self.bars, "eastmoney"))

            cached = read_history_cache(path, metadata)

            self.assertIsNotNone(cached)
            self.assertEqual(cached.provider, "eastmoney")
            self.assertEqual(cached.bars.iloc[0]["date"], "2026-07-10")
            self.assertEqual(
                path,
                history_cache_path(cache_dir, history_cache_metadata(self.stock, changed_context)),
            )
            self.assertNotEqual(
                path,
                history_cache_path(cache_dir, history_cache_metadata(self.stock, changed_adjust)),
            )

    def test_corrupt_cache_is_ignored(self) -> None:
        metadata = history_cache_metadata(self.stock, self.context)

        with tempfile.TemporaryDirectory() as directory:
            path = history_cache_path(Path(directory), metadata)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"not-a-gzip-cache")

            self.assertIsNone(read_history_cache(path, metadata))

    def test_cross_day_cache_fetches_only_overlap_and_incremental_tail(self) -> None:
        context = {
            **self.context,
            "startDate": "20260601",
            "endDate": "20260710",
            "sleep": 0,
            "requestTimeout": 12,
            "requestAttempts": 2,
        }
        cached_bars = make_bars({"2026-06-02": 9.0, "2026-07-08": 10.0, "2026-07-09": 10.1})
        incremental_bars = make_bars({"2026-07-08": 10.0, "2026-07-09": 10.1, "2026-07-10": 10.2})

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            metadata = history_cache_metadata(self.stock, context)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(
                path,
                metadata,
                StockHistory(self.stock, cached_bars, "eastmoney"),
                fetched_start="2026-06-01",
                fetched_through="2026-07-09",
            )
            with patch(
                "scripts.build_akshare_shard.fetch_stock_history",
                return_value=StockHistory(self.stock, incremental_bars, "eastmoney"),
            ) as fetch:
                history, cache_mode = load_or_fetch_history(self.stock, context, cache_dir)

            entry = read_history_cache_entry(path, metadata)

        self.assertEqual(cache_mode, "incremental")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.args[1:3], ("20260629", "20260710"))
        self.assertEqual(history.bars["date"].tolist(), ["2026-06-02", "2026-07-08", "2026-07-09", "2026-07-10"])
        self.assertEqual(entry.fetched_through, "2026-07-10")

    def test_qfq_overlap_change_forces_complete_refresh(self) -> None:
        context = {
            **self.context,
            "startDate": "20260601",
            "endDate": "20260710",
            "sleep": 0,
            "requestTimeout": 12,
            "requestAttempts": 2,
        }
        cached_bars = make_bars({"2026-06-02": 9.0, "2026-07-08": 10.0, "2026-07-09": 10.1})
        rebased_tail = make_bars({"2026-07-08": 9.5, "2026-07-09": 9.6, "2026-07-10": 10.2})
        rebased_full = make_bars({"2026-06-02": 8.5, "2026-07-08": 9.5, "2026-07-09": 9.6, "2026-07-10": 10.2})

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            metadata = history_cache_metadata(self.stock, context)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(
                path,
                metadata,
                StockHistory(self.stock, cached_bars, "eastmoney"),
                fetched_start="2026-06-01",
                fetched_through="2026-07-09",
            )
            with patch(
                "scripts.build_akshare_shard.fetch_stock_history",
                side_effect=[
                    StockHistory(self.stock, rebased_tail, "eastmoney"),
                    StockHistory(self.stock, rebased_full, "eastmoney"),
                ],
            ) as fetch:
                history, cache_mode = load_or_fetch_history(self.stock, context, cache_dir)

        self.assertEqual(cache_mode, "refresh")
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(fetch.call_args_list[1].args[1:3], ("20260601", "20260710"))
        self.assertEqual(history.bars.iloc[0]["close"], 8.5)

    def test_first_incremental_round_reuses_the_cached_provider(self) -> None:
        context = {
            **self.context,
            "startDate": "20260601",
            "endDate": "20260710",
            "sleep": 0,
            "requestTimeout": 12,
            "requestAttempts": 2,
            "_retryRoundIndex": 0,
        }
        cached_bars = make_bars({"2026-06-02": 9.0, "2026-07-09": 10.1})
        incremental_bars = make_bars({"2026-07-09": 10.1, "2026-07-10": 10.2})

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            metadata = history_cache_metadata(self.stock, context)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(
                path,
                metadata,
                StockHistory(self.stock, cached_bars, "sina"),
                fetched_start="2026-06-01",
                fetched_through="2026-07-09",
            )
            with patch(
                "scripts.build_akshare_shard.fetch_stock_history",
                return_value=StockHistory(self.stock, incremental_bars, "sina"),
            ) as fetch:
                history, cache_mode = load_or_fetch_history(self.stock, context, cache_dir)

        self.assertEqual(cache_mode, "incremental")
        self.assertEqual(history.provider, "sina")
        self.assertEqual(fetch.call_args.args[4], "sina")

    def test_suspension_is_cached_as_queried_through_without_filling_close(self) -> None:
        context = {
            **self.context,
            "startDate": "20260601",
            "endDate": "20260710",
            "sleep": 0,
            "requestTimeout": 12,
            "requestAttempts": 2,
        }
        suspended_bars = make_bars({"2026-06-02": 9.0, "2026-07-08": 10.0})

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            metadata = history_cache_metadata(self.stock, context)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(
                path,
                metadata,
                StockHistory(self.stock, suspended_bars, "eastmoney"),
                fetched_start="2026-06-01",
                fetched_through="2026-07-09",
            )
            with patch(
                "scripts.build_akshare_shard.fetch_stock_history",
                return_value=StockHistory(self.stock, suspended_bars, "eastmoney"),
            ) as fetch:
                history, cache_mode = load_or_fetch_history(self.stock, context, cache_dir)
            with patch("scripts.build_akshare_shard.fetch_stock_history") as second_fetch:
                cached_history, second_mode = load_or_fetch_history(self.stock, context, cache_dir)

        self.assertEqual(cache_mode, "incremental")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(second_mode, "full")
        second_fetch.assert_not_called()
        self.assertIsNone(exact_close(history.bars, "2026-07-10"))
        self.assertIsNone(exact_close(cached_history.bars, "2026-07-10"))

    def test_valid_v1_cache_is_migrated_without_refetching(self) -> None:
        context = {
            **self.context,
            "startDate": "20260601",
            "endDate": "20260710",
            "sleep": 0,
            "requestTimeout": 12,
            "requestAttempts": 2,
        }
        bars = make_bars({"2026-06-02": 9.0, "2026-07-10": 10.0})

        with tempfile.TemporaryDirectory() as directory:
            cache_root = Path(directory)
            cache_dir = cache_root / "akshare-history" / "3"
            v2_metadata = history_cache_metadata(self.stock, context)
            v2_path = history_cache_path(cache_dir, v2_metadata)
            legacy_path = cache_root / "akshare-history-v1" / "7" / "000001-legacy-v1.json.gz"
            legacy_path.parent.mkdir(parents=True, exist_ok=True)
            legacy_metadata = {
                **v2_metadata,
                "version": 1,
                "startDate": "20260601",
                "endDate": "20260710",
                "requestAttempts": 2,
            }
            with gzip.open(legacy_path, "wt", encoding="utf-8") as handle:
                json.dump({
                    "metadata": legacy_metadata,
                    "provider": "eastmoney",
                    "bars": json.loads(bars.to_json(orient="records", force_ascii=False)),
                }, handle)

            with patch("scripts.build_akshare_shard.fetch_stock_history") as fetch:
                history, cache_mode = load_or_fetch_history(self.stock, context, cache_dir)

            migrated = read_history_cache_entry(v2_path, v2_metadata)

        fetch.assert_not_called()
        self.assertEqual(cache_mode, "full")
        self.assertEqual(history.bars.iloc[-1]["date"], "2026-07-10")
        self.assertIsNotNone(migrated)


class ProgressTests(unittest.TestCase):
    def test_retry_rounds_only_request_the_unresolved_subset(self) -> None:
        stocks = [StockItem(f"{index:06d}", f"测试{index}", "测试") for index in range(3)]
        bars = make_bars({"2026-07-10": 10.0})
        rounds = [
            (
                [StockHistory(stocks[0], bars, "eastmoney")],
                [
                    {"code": stocks[1].code, "name": stocks[1].name, "error": "temporary"},
                    {"code": stocks[2].code, "name": stocks[2].name, "error": "temporary"},
                ],
                Counter({"eastmoney": 1}),
                Counter({"miss": 1}),
            ),
            (
                [StockHistory(stocks[1], bars, "eastmoney")],
                [{"code": stocks[2].code, "name": stocks[2].name, "error": "temporary"}],
                Counter({"eastmoney": 1}),
                Counter({"miss": 1}),
            ),
            (
                [StockHistory(stocks[2], bars, "eastmoney")],
                [],
                Counter({"eastmoney": 1}),
                Counter({"miss": 1}),
            ),
        ]

        with (
            tempfile.TemporaryDirectory() as directory,
            patch("scripts.build_akshare_shard.fetch_shard_histories", side_effect=rounds) as fetch,
            patch("scripts.build_akshare_shard.time.sleep"),
        ):
            histories, failures, providers, cache_counts = fetch_shard_histories_with_retries(
                stocks,
                {
                    "historyRetryRounds": 4,
                    "historyRetryBackoffSeconds": 0,
                    "historySource": "eastmoney",
                    "softDeadlineMinutes": 5,
                    "shardCount": 1,
                },
                Path(directory),
                heartbeat_seconds=999,
                shard_index=0,
            )

        self.assertEqual([history.stock.code for history in histories], [stock.code for stock in stocks])
        self.assertEqual(failures, [])
        self.assertEqual(providers, Counter({"eastmoney": 3}))
        self.assertEqual(cache_counts, Counter({"miss": 3}))
        self.assertEqual(
            [[stock.code for stock in call.args[0]] for call in fetch.call_args_list],
            [[stock.code for stock in stocks], [stocks[1].code, stocks[2].code], [stocks[2].code]],
        )
        self.assertFalse(fetch.call_args_list[0].args[1]["_allowProviderFallbackThisRound"])
        self.assertTrue(fetch.call_args_list[1].args[1]["_allowProviderFallbackThisRound"])
        self.assertEqual(fetch.call_args_list[0].args[1]["_historySourceThisRound"], "eastmoney")
        self.assertEqual(fetch.call_args_list[1].args[1]["_historySourceThisRound"], "sina")

    def test_fast_completions_do_not_emit_one_log_line_per_stock(self) -> None:
        stocks = [StockItem(f"{index:06d}", f"测试{index}", "测试") for index in range(30)]
        bars = pd.DataFrame(
            [{
                "date": "2026-07-10",
                "open": 10.0,
                "close": 10.0,
                "high": 10.0,
                "low": 10.0,
                "volume": 1.0,
                "amount": 1.0,
            }]
        )

        def complete(stock, _context, _cache_dir):
            return StockHistory(stock, bars, "eastmoney"), "miss"

        output = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("scripts.build_akshare_shard.load_or_fetch_history", side_effect=complete),
            redirect_stdout(output),
        ):
            histories, failures, _providers, _hits = fetch_shard_histories(
                stocks,
                {"maxWorkers": 4, "shardCount": 1},
                Path(directory),
                heartbeat_seconds=999,
                shard_index=0,
            )

        progress_lines = [line for line in output.getvalue().splitlines() if " progress " in line]
        self.assertEqual(len(histories), 30)
        self.assertEqual(failures, [])
        self.assertGreaterEqual(len(progress_lines), 1)
        self.assertLessEqual(len(progress_lines), 2)

    def test_systemic_failures_open_circuit_and_account_for_all_stocks(self) -> None:
        stocks = [StockItem(f"{index:06d}", f"测试{index}", "测试") for index in range(20)]
        output = io.StringIO()

        with (
            tempfile.TemporaryDirectory() as directory,
            patch(
                "scripts.build_akshare_shard.load_or_fetch_history",
                side_effect=RuntimeError("provider unavailable"),
            ) as fetch,
            redirect_stdout(output),
        ):
            histories, failures, _providers, _hits = fetch_shard_histories(
                stocks,
                {
                    "maxWorkers": 1,
                    "maxConsecutiveFailures": 3,
                    "shardCount": 1,
                },
                Path(directory),
                heartbeat_seconds=999,
                shard_index=0,
            )

        self.assertEqual(histories, [])
        self.assertEqual(len(failures), len(stocks))
        self.assertEqual(fetch.call_count, 3)
        self.assertIn("stopped before the hard timeout", output.getvalue())


if __name__ == "__main__":
    unittest.main()
