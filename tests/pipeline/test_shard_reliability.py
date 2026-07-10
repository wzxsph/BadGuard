from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import requests

from scripts.build_akshare_shard import (
    fetch_shard_histories,
    history_cache_metadata,
    history_cache_path,
    read_history_cache,
    write_history_cache,
)
from scripts.build_akshare_snapshot import (
    StockHistory,
    StockItem,
    fetch_eastmoney_history,
    fetch_history,
)
from scripts.http_timeout import install_default_requests_timeout


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

    def test_cache_round_trip_and_context_isolation(self) -> None:
        metadata = history_cache_metadata(self.stock, self.context)
        changed_context = {**self.context, "endDate": "20260713"}

        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            path = history_cache_path(cache_dir, metadata)
            write_history_cache(path, metadata, StockHistory(self.stock, self.bars, "eastmoney"))

            cached = read_history_cache(path, metadata)

            self.assertIsNotNone(cached)
            self.assertEqual(cached.provider, "eastmoney")
            self.assertEqual(cached.bars.iloc[0]["date"], "2026-07-10")
            self.assertNotEqual(
                path,
                history_cache_path(cache_dir, history_cache_metadata(self.stock, changed_context)),
            )

    def test_corrupt_cache_is_ignored(self) -> None:
        metadata = history_cache_metadata(self.stock, self.context)

        with tempfile.TemporaryDirectory() as directory:
            path = history_cache_path(Path(directory), metadata)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"not-a-gzip-cache")

            self.assertIsNone(read_history_cache(path, metadata))


class ProgressTests(unittest.TestCase):
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
            return StockHistory(stock, bars, "eastmoney"), False

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
