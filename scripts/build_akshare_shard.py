#!/usr/bin/env python3
"""Fetch and evaluate one deterministic slice of an AkShare run context."""

from __future__ import annotations

import argparse
from collections import Counter
import concurrent.futures
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from typing import Any

import pandas as pd
import numpy as np
try:
    from scripts.build_akshare_snapshot import (
        CHINA_TZ,
        StockHistory,
        StockItem,
        build_baseline_closes,
        enrich_row_industries,
        evaluate_stock_for_date,
        fetch_stock_history,
        previous_trading_dates,
        write_json,
    )
    from scripts.http_timeout import install_default_requests_timeout
    from scripts.prepare_akshare_context import load_and_validate_context
except ModuleNotFoundError:  # Direct `python scripts/...py` execution.
    from build_akshare_snapshot import (  # type: ignore[no-redef]
        CHINA_TZ,
        StockHistory,
        StockItem,
        build_baseline_closes,
        enrich_row_industries,
        evaluate_stock_for_date,
        fetch_stock_history,
        previous_trading_dates,
        write_json,
    )
    from http_timeout import install_default_requests_timeout  # type: ignore[no-redef]
    from prepare_akshare_context import load_and_validate_context  # type: ignore[no-redef]


SHARD_VERSION = 1
CACHE_VERSION = 1
HEARTBEAT_SECONDS = 30


def main() -> None:
    args = parse_args()
    context = load_and_validate_context(args.context)
    if args.shard_count is not None and args.shard_count != context["shardCount"]:
        raise SystemExit("CLI shard-count does not match the prepared context.")
    if args.shard_index < 0 or args.shard_index >= context["shardCount"]:
        raise SystemExit(f"shard-index must be between 0 and {context['shardCount'] - 1}.")

    payload = build_shard(
        context,
        args.shard_index,
        Path(args.history_cache_dir),
        heartbeat_seconds=args.heartbeat_seconds,
    )
    write_json(Path(args.output), payload)
    print(
        f"Shard {args.shard_index + 1}/{context['shardCount']} complete: "
        f"{payload['historySuccessCount']}/{payload['stockCount']} histories, "
        f"{payload['cacheHitCount']} cache hits, {len(payload['failures'])} failures.",
        flush=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one deterministic AkShare history shard.")
    parser.add_argument("--context", required=True)
    parser.add_argument("--shard-index", type=int, required=True)
    parser.add_argument("--shard-count", type=int)
    parser.add_argument("--output", required=True)
    parser.add_argument("--history-cache-dir", default=".cache/akshare-history")
    parser.add_argument("--heartbeat-seconds", type=float, default=HEARTBEAT_SECONDS)
    return parser.parse_args()


def build_shard(
    context: dict[str, Any],
    shard_index: int,
    history_cache_dir: Path,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> dict[str, Any]:
    shard_count = context["shardCount"]
    all_stocks = [StockItem(**item) for item in context["stocks"]]
    stocks = select_shard_stocks(all_stocks, shard_index, shard_count)
    if not stocks:
        raise ValueError(f"Shard {shard_index} was assigned no stocks.")

    install_default_requests_timeout(float(context["requestTimeout"]))
    histories, failures, provider_counts, cache_hit_count = fetch_shard_histories(
        stocks,
        context,
        history_cache_dir,
        heartbeat_seconds,
        shard_index,
    )
    histories.sort(key=lambda history: history.stock.code)

    dates: dict[str, dict[str, Any]] = {}
    all_rows: list[dict[str, Any]] = []
    published_dates = context["calendar"]["tradingDates"]
    for target in context["targets"]:
        rows: list[dict[str, Any]] = []
        closes: dict[str, float] = {}
        baseline_dates = previous_trading_dates(published_dates, target, 2)
        baselines = build_baseline_closes(histories, baseline_dates)
        for history in histories:
            stock_rows, close_value = evaluate_stock_for_date(history.stock, history.bars, target)
            rows.extend(stock_rows)
            if close_value is not None:
                closes[history.stock.code] = close_value
        dates[target] = {
            "rows": rows,
            "closes": closes,
            "baselineCloses": baselines,
        }
        all_rows.extend(rows)

    if all_rows and not context["skipIndustryMap"]:
        enrich_row_industries(
            all_rows,
            context["endDate"],
            max_workers=min(int(context["maxWorkers"]), 4),
            sleep_seconds=float(context["sleep"]),
        )

    success_codes = sorted(history.stock.code for history in histories)
    return {
        "version": SHARD_VERSION,
        "contextHash": context["contextHash"],
        "shardIndex": shard_index,
        "shardCount": shard_count,
        "stockCount": len(stocks),
        "stockCodes": [stock.code for stock in stocks],
        "historySuccessCount": len(histories),
        "successCodes": success_codes,
        "providerCounts": dict(sorted(provider_counts.items())),
        "cacheHitCount": cache_hit_count,
        "failures": failures,
        "dates": dates,
        "finishedAt": datetime.now(CHINA_TZ).isoformat(),
    }


def select_shard_stocks(stocks: list[StockItem], shard_index: int, shard_count: int) -> list[StockItem]:
    if shard_count <= 0 or shard_index < 0 or shard_index >= shard_count:
        raise ValueError("Invalid shard index/count.")
    ordered = sorted(stocks, key=lambda stock: stock.code)
    return [stock for index, stock in enumerate(ordered) if index % shard_count == shard_index]


def fetch_shard_histories(
    stocks: list[StockItem],
    context: dict[str, Any],
    cache_dir: Path,
    heartbeat_seconds: float,
    shard_index: int,
) -> tuple[list[StockHistory], list[dict[str, str]], Counter[str], int]:
    histories: list[StockHistory] = []
    failures: list[dict[str, str]] = []
    provider_counts: Counter[str] = Counter()
    cache_hit_count = 0
    completed = 0
    started_at = time.monotonic()
    last_heartbeat = started_at
    last_report_completed = 0
    max_workers = max(1, int(context["maxWorkers"]))
    maximum_consecutive_failures = max(1, int(context.get("maxConsecutiveFailures", 12)))
    soft_deadline = started_at + max(1.0, float(context.get("softDeadlineMinutes", 60.0))) * 60
    consecutive_failures = 0
    next_stock_index = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        pending: dict[concurrent.futures.Future[tuple[StockHistory, bool]], StockItem] = {}

        def fill_workers() -> None:
            nonlocal next_stock_index
            while len(pending) < max_workers and next_stock_index < len(stocks):
                stock = stocks[next_stock_index]
                next_stock_index += 1
                pending[executor.submit(load_or_fetch_history, stock, context, cache_dir)] = stock

        fill_workers()
        while pending:
            done, not_done = concurrent.futures.wait(
                pending,
                timeout=max(0.1, heartbeat_seconds),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            now = time.monotonic()
            for future in done:
                stock = pending[future]
                completed += 1
                try:
                    history, cache_hit = future.result()
                    histories.append(history)
                    provider_counts[history.provider] += 1
                    cache_hit_count += int(cache_hit)
                    consecutive_failures = 0
                except Exception as exc:  # pragma: no cover - provider variability
                    failures.append({"code": stock.code, "name": stock.name, "error": str(exc)})
                    consecutive_failures += 1
            pending = {future: pending[future] for future in not_done}
            circuit_reason = None
            if consecutive_failures >= maximum_consecutive_failures:
                circuit_reason = f"provider circuit opened after {consecutive_failures} consecutive failures"
            elif now >= soft_deadline:
                circuit_reason = "shard soft deadline reached"
            if circuit_reason:
                remaining = stocks[next_stock_index:]
                failures.extend({
                    "code": stock.code,
                    "name": stock.name,
                    "error": circuit_reason,
                } for stock in remaining)
                completed += len(remaining)
                next_stock_index = len(stocks)
                print(
                    f"Shard {shard_index + 1}/{context['shardCount']} stopped before the hard timeout; "
                    f"skipped {len(remaining)} queued stocks so cached progress can be retained.",
                    flush=True,
                )
            else:
                fill_workers()
            should_report = (
                completed == len(stocks)
                or completed - last_report_completed >= 25
                or now - last_heartbeat >= heartbeat_seconds
            )
            if should_report:
                elapsed = max(now - started_at, 0.001)
                rate = completed / elapsed
                eta_text = f"{((len(stocks) - completed) / rate) / 60:.1f}m" if rate > 0 else "unknown"
                print(
                    f"Shard {shard_index + 1}/{context['shardCount']} progress "
                    f"{completed}/{len(stocks)} success={len(histories)} failures={len(failures)} "
                    f"cache={cache_hit_count} rate={rate:.2f}/s eta={eta_text}",
                    flush=True,
                )
                last_heartbeat = now
                last_report_completed = completed

    return histories, failures, provider_counts, cache_hit_count


def load_or_fetch_history(
    stock: StockItem,
    context: dict[str, Any],
    cache_dir: Path,
) -> tuple[StockHistory, bool]:
    metadata = history_cache_metadata(stock, context)
    path = history_cache_path(cache_dir, metadata)
    cached = read_history_cache(path, metadata)
    if cached is not None:
        return cached, True

    history = fetch_stock_history(
        stock,
        context["startDate"],
        context["endDate"],
        "" if context["adjust"] == "none" else context["adjust"],
        context["historySource"],
        float(context["sleep"]),
        float(context["requestTimeout"]),
        int(context["requestAttempts"]),
        bool(context["allowProviderFallback"]),
    )
    if history.bars.empty:
        raise RuntimeError("provider returned no normalized bars")
    write_history_cache(path, metadata, history)
    return history, False


def history_cache_metadata(stock: StockItem, context: dict[str, Any]) -> dict[str, Any]:
    try:
        import akshare

        akshare_version = getattr(akshare, "__version__", "unknown")
    except Exception:  # pragma: no cover - import already succeeded in the builder
        akshare_version = "unknown"
    return {
        "version": CACHE_VERSION,
        "code": stock.code,
        "name": stock.name,
        "industry": stock.industry,
        "startDate": context["startDate"],
        "endDate": context["endDate"],
        "adjust": context["adjust"],
        "historySource": context["historySource"],
        "requestAttempts": context.get("requestAttempts", 2),
        "allowProviderFallback": context["allowProviderFallback"],
        "akshareVersion": akshare_version,
    }


def history_cache_path(cache_dir: Path, metadata: dict[str, Any]) -> Path:
    encoded = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    fingerprint = hashlib.sha256(encoded).hexdigest()[:20]
    return cache_dir / f"{metadata['code']}-{fingerprint}.json.gz"


def read_history_cache(path: Path, expected_metadata: dict[str, Any]) -> StockHistory | None:
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("metadata") != expected_metadata or not isinstance(payload.get("bars"), list) or not payload["bars"]:
            return None
        bars = pd.DataFrame(payload["bars"])
        required = {"date", "open", "close", "high", "low", "volume", "amount"}
        if not required.issubset(bars.columns):
            return None
        if not cached_bars_are_valid(bars, expected_metadata):
            path.unlink(missing_ok=True)
            return None
        stock = StockItem(expected_metadata["code"], expected_metadata["name"], expected_metadata["industry"])
        provider = payload.get("provider")
        if provider not in {"sina", "eastmoney"}:
            return None
        return StockHistory(stock=stock, bars=bars, provider=provider)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def write_history_cache(path: Path, metadata: dict[str, Any], history: StockHistory) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bars = json.loads(history.bars.to_json(orient="records", force_ascii=False))
    payload = {"metadata": metadata, "provider": history.provider, "bars": bars}
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as raw:
        temporary_path = Path(raw.name)
    try:
        with gzip.open(temporary_path, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def cached_bars_are_valid(bars: pd.DataFrame, metadata: dict[str, Any]) -> bool:
    dates = bars["date"].astype(str)
    parsed_dates = pd.to_datetime(dates, errors="coerce")
    if parsed_dates.isna().any() or dates.duplicated().any() or dates.tolist() != sorted(dates.tolist()):
        return False
    if dates.iloc[0].replace("-", "") < metadata["startDate"] or dates.iloc[-1].replace("-", "") > metadata["endDate"]:
        return False
    numeric = bars[["open", "close", "high", "low", "volume", "amount"]].apply(pd.to_numeric, errors="coerce")
    return bool(
        numeric.notna().all().all()
        and np.isfinite(numeric.to_numpy()).all()
        and (numeric[["open", "close", "high", "low"]] > 0).all().all()
    )


if __name__ == "__main__":
    main()
