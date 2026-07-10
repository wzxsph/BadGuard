from __future__ import annotations

import argparse
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from scripts.build_akshare_snapshot import (
    MIN_DAILY_AMOUNT,
    MIN_FLOAT_MARKET_CAP,
    StockHistory,
    StockItem,
    append_candidate,
    assemble_snapshot,
    build_baseline_closes,
    calendar_publication_dates,
    evaluate_stock_for_date,
    liquidity_status,
    make_row,
    normalize_history,
    previous_trading_dates,
    resolve_target_dates,
    row_sort_key,
    source_for_target,
)


class HistoryNormalizationTests(unittest.TestCase):
    def test_sina_liquidity_units(self) -> None:
        frame = pd.DataFrame(
            [
                {
                    "date": "2026-07-08",
                    "open": 9.8,
                    "close": 10.0,
                    "high": 10.2,
                    "low": 9.7,
                    "volume": 6_000_000,
                    "amount": 300_000_000,
                    "outstanding_share": 600_000_000,
                    "turnover": 0.01,
                }
            ]
        )

        row = normalize_history(frame, "sina").iloc[0]

        self.assertEqual(row["turnover_rate"], 1.0)
        self.assertEqual(row["float_market_cap"], 6_000_000_000)

    def test_eastmoney_lots_and_percentage_units(self) -> None:
        frame = pd.DataFrame(
            [
                {
                    "日期": "2026-07-08",
                    "开盘": 9.8,
                    "收盘": 10.0,
                    "最高": 10.2,
                    "最低": 9.7,
                    "成交量": 100_000,
                    "成交额": 300_000_000,
                    "换手率": 2.0,
                }
            ]
        )

        row = normalize_history(frame, "eastmoney").iloc[0]

        self.assertEqual(row["turnover_rate"], 2.0)
        self.assertEqual(row["float_shares"], 500_000_000)
        self.assertEqual(row["float_market_cap"], 5_000_000_000)

    def test_missing_optional_liquidity_does_not_drop_ohlcva(self) -> None:
        frame = pd.DataFrame(
            [
                {
                    "date": "2026-07-08",
                    "open": 10,
                    "close": 10,
                    "high": 10,
                    "low": 10,
                    "volume": 1,
                    "amount": 1,
                }
            ]
        )

        normalized = normalize_history(frame, "sina")

        self.assertEqual(len(normalized), 1)
        self.assertTrue(np.isnan(normalized.iloc[0]["turnover_rate"]))
        self.assertTrue(np.isnan(normalized.iloc[0]["float_market_cap"]))


class LiquidityGateTests(unittest.TestCase):
    def test_inclusive_boundary_is_eligible(self) -> None:
        eligible, tags = liquidity_status(MIN_DAILY_AMOUNT, MIN_FLOAT_MARKET_CAP, 1.5)

        self.assertTrue(eligible)
        self.assertEqual(tags, [])

    def test_each_hard_gate_and_missing_metric_is_rejected(self) -> None:
        self.assertFalse(liquidity_status(MIN_DAILY_AMOUNT - 1, MIN_FLOAT_MARKET_CAP, 1)[0])
        self.assertFalse(liquidity_status(MIN_DAILY_AMOUNT, MIN_FLOAT_MARKET_CAP - 1, 1)[0])
        eligible, tags = liquidity_status(MIN_DAILY_AMOUNT, None, None)
        self.assertFalse(eligible)
        self.assertIn("流动性数据缺失", tags)

    def test_gate_uses_raw_value_before_display_rounding(self) -> None:
        current, previous = indicator_rows(
            amount=MIN_DAILY_AMOUNT - 0.4,
            float_market_cap=MIN_FLOAT_MARKET_CAP,
        )

        row = make_row("trend-strength", StockItem("000001", "测试", "未分类"), current, previous, 0, 0, 50)

        self.assertEqual(row["amount"], MIN_DAILY_AMOUNT)
        self.assertFalse(row["liquidityEligible"])

    def test_turnover_is_display_only(self) -> None:
        eligible, tags = liquidity_status(MIN_DAILY_AMOUNT, MIN_FLOAT_MARKET_CAP, 25.0)

        self.assertTrue(eligible)
        self.assertIn("换手率异常", tags)

    def test_observation_is_filtered_but_risk_is_retained(self) -> None:
        observation_rows: list[dict] = []
        risk_rows: list[dict] = []

        append_candidate(observation_rows, {"signalId": "low-rebound", "liquidityEligible": False})
        append_candidate(risk_rows, {"signalId": "risk-filter", "liquidityEligible": False})

        self.assertEqual(observation_rows, [])
        self.assertEqual(len(risk_rows), 1)

    def test_missing_liquidity_is_annotated_on_risk_row(self) -> None:
        current, previous = indicator_rows(float_market_cap=np.nan, turnover_rate=np.nan)

        row = make_row("risk-filter", StockItem("000001", "测试", "未分类"), current, previous, 0, 0, 50)

        self.assertFalse(row["liquidityEligible"])
        self.assertIn("流动性数据缺失", row["liquidityTags"])
        self.assertIsNone(row["floatMarketCap"])

    def test_sort_prefers_larger_float_cap_then_code(self) -> None:
        rows = [
            {"signalStrength": 80, "floatMarketCap": 5_000_000_000, "code": "000003"},
            {"signalStrength": 80, "floatMarketCap": 8_000_000_000, "code": "000002"},
            {"signalStrength": 80, "floatMarketCap": 8_000_000_000, "code": "000001"},
            {"signalStrength": 80, "floatMarketCap": None, "code": "000000"},
            {"signalStrength": 90, "floatMarketCap": 1, "code": "000009"},
        ]

        ordered = sorted(rows, key=row_sort_key)

        self.assertEqual([row["code"] for row in ordered], ["000009", "000001", "000002", "000003", "000000"])


class TargetDateTests(unittest.TestCase):
    def test_exact_date_close_does_not_carry_forward(self) -> None:
        bars = pd.DataFrame(
            [
                {"date": "2026-07-08", "close": 10.0},
                {"date": "2026-07-10", "close": 11.0},
            ]
        )
        stock = StockItem("000001", "测试", "未分类")

        rows, close = evaluate_stock_for_date(stock, bars, "2026-07-09")

        self.assertEqual(rows, [])
        self.assertIsNone(close)

    def test_explicit_market_date_survives_empty_observation_board(self) -> None:
        snapshot = assemble_snapshot([], 80, "test", {}, "2026-07-08")

        self.assertEqual(snapshot["marketDate"], "2026-07-08")

    def test_backfill_uses_exchange_calendar_not_weekends(self) -> None:
        args = argparse.Namespace(
            end_date=None,
            target_date=None,
            backfill_start="20260708",
            backfill_end="20260713",
        )
        calendar = ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13"]

        targets = resolve_target_dates(args, calendar, datetime(2026, 7, 14, 10, tzinfo=ZoneInfo("Asia/Shanghai")))

        self.assertEqual(targets, calendar)

    def test_default_before_close_uses_prior_completed_trade_date(self) -> None:
        args = argparse.Namespace(
            end_date=None,
            target_date=None,
            backfill_start=None,
            backfill_end=None,
        )
        calendar = ["2026-07-08", "2026-07-09", "2026-07-10"]

        targets = resolve_target_dates(args, calendar, datetime(2026, 7, 10, 14, 59, tzinfo=ZoneInfo("Asia/Shanghai")))

        self.assertEqual(targets, ["2026-07-09"])

    def test_bootstrap_combines_backfill_and_live_in_one_target_set(self) -> None:
        args = argparse.Namespace(
            end_date=None,
            target_date=None,
            backfill_start="20260708",
            backfill_end=None,
            include_live_target=True,
            snapshot_source="backfill",
        )
        calendar = ["2026-07-08", "2026-07-09", "2026-07-10"]
        now = datetime(2026, 7, 10, 15, 30, tzinfo=ZoneInfo("Asia/Shanghai"))

        targets = resolve_target_dates(args, calendar, now)

        self.assertEqual(targets, calendar)
        self.assertEqual([source_for_target(args, calendar, now, target) for target in targets], ["backfill", "backfill", "live"])

    def test_close_table_baseline_uses_same_rebased_series_and_exact_trade_dates(self) -> None:
        stock = StockItem("000001", "测试", "未分类")
        rebased_bars = pd.DataFrame(
            [
                {"date": "2026-07-08", "close": 9.0},
                {"date": "2026-07-09", "close": 9.9},
            ]
        )
        history = StockHistory(stock=stock, bars=rebased_bars, provider="sina")
        calendar = calendar_publication_dates(["2026-07-07", "2026-07-08", "2026-07-09"])
        baseline_dates = previous_trading_dates(calendar, "2026-07-09", 2)

        baselines = build_baseline_closes([history], baseline_dates)

        self.assertEqual(baselines, {"2026-07-08": {"000001": 9.0}})
        rebased_return = (9.9 / baselines["2026-07-08"]["000001"] - 1) * 100
        self.assertAlmostEqual(rebased_return, 10.0)

    def test_first_history_date_has_no_pre_history_baselines(self) -> None:
        calendar = calendar_publication_dates(["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09"])

        self.assertEqual(calendar, ["2026-07-08", "2026-07-09"])
        self.assertEqual(previous_trading_dates(calendar, "2026-07-08", 2), [])


def indicator_rows(**overrides: float) -> tuple[pd.Series, pd.Series]:
    base = {
        "date": "2026-07-08",
        "open": 10.0,
        "close": 10.0,
        "high": 10.2,
        "low": 9.8,
        "volume": 1_000_000,
        "amount": 100_000_000,
        "turnover_rate": 1.0,
        "float_market_cap": 4_000_000_000,
        "k": 20.0,
        "d": 21.0,
        "j": 18.0,
        "dif": -0.1,
        "dea": -0.1,
        "histogram": 0.0,
        "rsi": 30.0,
        "ma5": 10.1,
        "ma10": 10.2,
        "ma20": 10.3,
        "boll_lower": 9.7,
        "volume_ratio": 1.5,
    }
    base.update(overrides)
    previous = {**base, "date": "2026-07-07", "close": 10.2, "k": 22.0, "d": 21.0}
    return pd.Series(base), pd.Series(previous)


if __name__ == "__main__":
    unittest.main()
