#!/usr/bin/env python3
"""Fetch and evaluate one deterministic slice of an AkShare run context."""

from __future__ import annotations

import argparse
from collections import Counter
import concurrent.futures
from dataclasses import dataclass
from datetime import datetime, timedelta
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


SHARD_VERSION = 2
CACHE_VERSION = 2
HEARTBEAT_SECONDS = 30
INCREMENTAL_OVERLAP_DAYS = 10


@dataclass(frozen=True)
class HistoryCacheEntry:
    history: StockHistory
    fetched_start: str
    fetched_through: str


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
    histories, failures, provider_counts, cache_counts = fetch_shard_histories_with_retries(
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
    stale_codes = set(context["universeStaleCodes"])
    required_only_codes = set(context["requiredOnlyCodes"])
    for target in context["targets"]:
        rows: list[dict[str, Any]] = []
        closes: dict[str, float] = {}
        not_listed_codes: list[str] = []
        suspended_codes: list[str] = []
        baseline_dates = previous_trading_dates(published_dates, target, 2)
        baselines = build_baseline_closes(histories, baseline_dates)
        for history in histories:
            stock_rows, close_value = evaluate_stock_for_date(history.stock, history.bars, target)
            for row in stock_rows:
                if history.stock.code in stale_codes:
                    row["universeStatus"] = "stale"
                elif history.stock.code in required_only_codes:
                    row["universeStatus"] = "required-only"
                else:
                    row["universeStatus"] = "active"
            rows.extend(stock_rows)
            if close_value is not None:
                closes[history.stock.code] = close_value
            elif target < str(history.bars.iloc[0]["date"]):
                not_listed_codes.append(history.stock.code)
            else:
                # A successful history response without an exact exchange-day bar
                # represents a suspension/no-trade day. Never carry the prior close
                # forward: downstream returns must remain missing for this code/date.
                suspended_codes.append(history.stock.code)
        dates[target] = {
            "rows": rows,
            "closes": closes,
            "baselineCloses": baselines,
            "notListedCodes": sorted(not_listed_codes),
            "suspendedCodes": sorted(suspended_codes),
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
        "cacheHitCount": cache_counts["full"] + cache_counts["incremental"],
        "cacheFullHitCount": cache_counts["full"],
        "cacheIncrementalHitCount": cache_counts["incremental"],
        "cacheRefreshCount": cache_counts["refresh"],
        "failures": failures,
        "dates": dates,
        "finishedAt": datetime.now(CHINA_TZ).isoformat(),
    }


def select_shard_stocks(stocks: list[StockItem], shard_index: int, shard_count: int) -> list[StockItem]:
    if shard_count <= 0 or shard_index < 0 or shard_index >= shard_count:
        raise ValueError("Invalid shard index/count.")
    ordered = sorted(stocks, key=lambda stock: stock.code)
    # Code-based assignment stays stable when listings are inserted or removed;
    # index-based modulo would reshuffle nearly the entire universe every day.
    return [stock for stock in ordered if int(stock.code) % shard_count == shard_index]


def fetch_shard_histories(
    stocks: list[StockItem],
    context: dict[str, Any],
    cache_dir: Path,
    heartbeat_seconds: float,
    shard_index: int,
) -> tuple[list[StockHistory], list[dict[str, str]], Counter[str], Counter[str]]:
    histories: list[StockHistory] = []
    failures: list[dict[str, str]] = []
    provider_counts: Counter[str] = Counter()
    cache_counts: Counter[str] = Counter()
    completed = 0
    started_at = time.monotonic()
    last_heartbeat = started_at
    last_report_completed = 0
    max_workers = max(1, int(context["maxWorkers"]))
    maximum_consecutive_failures = max(1, int(context.get("maxConsecutiveFailures", 12)))
    soft_deadline = float(
        context.get(
            "_absoluteSoftDeadline",
            started_at + max(1.0, float(context.get("softDeadlineMinutes", 60.0))) * 60,
        )
    )
    consecutive_failures = 0
    next_stock_index = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        pending: dict[concurrent.futures.Future[tuple[StockHistory, str]], StockItem] = {}

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
                    history, cache_mode = future.result()
                    if cache_mode not in {"miss", "full", "incremental", "refresh"}:
                        raise ValueError(f"Unknown cache result mode: {cache_mode}")
                    histories.append(history)
                    provider_counts[history.provider] += 1
                    cache_counts[cache_mode] += 1
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
                    f"cache-full={cache_counts['full']} cache-incremental={cache_counts['incremental']} "
                    f"cache-refresh={cache_counts['refresh']} rate={rate:.2f}/s eta={eta_text}",
                    flush=True,
                )
                last_heartbeat = now
                last_report_completed = completed

    return histories, failures, provider_counts, cache_counts


def fetch_shard_histories_with_retries(
    stocks: list[StockItem],
    context: dict[str, Any],
    cache_dir: Path,
    heartbeat_seconds: float,
    shard_index: int,
) -> tuple[list[StockHistory], list[dict[str, str]], Counter[str], Counter[str]]:
    """Retry only unresolved stocks under one shard-level deadline."""

    maximum_rounds = max(1, int(context.get("historyRetryRounds", 4)))
    backoff_seconds = max(0.0, float(context.get("historyRetryBackoffSeconds", 3.0)))
    absolute_deadline = time.monotonic() + max(
        1.0,
        float(context.get("softDeadlineMinutes", 60.0)) * 60,
    )
    stock_by_code = {stock.code: stock for stock in stocks}
    successes: dict[str, StockHistory] = {}
    provider_counts: Counter[str] = Counter()
    cache_counts: Counter[str] = Counter()
    remaining = list(stocks)
    final_failures: list[dict[str, str]] = []

    for round_index in range(maximum_rounds):
        if not remaining or time.monotonic() >= absolute_deadline:
            break
        round_context = {**context, "_absoluteSoftDeadline": absolute_deadline}
        print(
            f"Shard {shard_index + 1}/{context['shardCount']} fetch round "
            f"{round_index + 1}/{maximum_rounds}: {len(remaining)} unresolved stocks.",
            flush=True,
        )
        histories, failures, round_provider_counts, round_cache_counts = fetch_shard_histories(
            remaining,
            round_context,
            cache_dir,
            heartbeat_seconds,
            shard_index,
        )
        for history in histories:
            successes[history.stock.code] = history
        provider_counts.update(round_provider_counts)
        cache_counts.update(round_cache_counts)
        final_failures = failures
        failed_codes = {str(failure.get("code")) for failure in failures}
        remaining = [stock_by_code[code] for code in sorted(failed_codes) if code in stock_by_code]
        if not remaining or round_index + 1 >= maximum_rounds:
            break

        delay = min(
            backoff_seconds * (2 ** round_index),
            max(0.0, absolute_deadline - time.monotonic()),
        )
        if delay > 0:
            print(
                f"Shard {shard_index + 1}/{context['shardCount']} will retry "
                f"{len(remaining)} unresolved stocks after {delay:.1f}s.",
                flush=True,
            )
            time.sleep(delay)

    unresolved_codes = set(stock_by_code) - set(successes)
    failure_by_code = {str(failure.get("code")): failure for failure in final_failures}
    final_failures = [
        failure_by_code.get(
            code,
            {
                "code": code,
                "name": stock_by_code[code].name,
                "error": "shard soft deadline reached before the next retry round",
            },
        )
        for code in sorted(unresolved_codes)
    ]
    return (
        [successes[code] for code in sorted(successes)],
        final_failures,
        provider_counts,
        cache_counts,
    )


def load_or_fetch_history(
    stock: StockItem,
    context: dict[str, Any],
    cache_dir: Path,
) -> tuple[StockHistory, str]:
    metadata = history_cache_metadata(stock, context)
    path = history_cache_path(cache_dir, metadata)
    cached = read_history_cache_entry(path, metadata)
    if cached is None:
        cached = migrate_legacy_history_cache(cache_dir, path, metadata)
    requested_start = normalize_cache_date(context["startDate"])
    requested_end = normalize_cache_date(context["endDate"])
    if cached is not None and cached.fetched_start <= requested_start and cached.fetched_through >= requested_end:
        return slice_history(cached.history, requested_start, requested_end), "full"

    if cached is not None and cached.fetched_start <= requested_start and not cached.history.bars.empty:
        last_cached_date = str(cached.history.bars.iloc[-1]["date"])
        if last_cached_date >= requested_start:
            overlap_start = max(
                requested_start,
                (datetime.strptime(last_cached_date, "%Y-%m-%d") - timedelta(days=INCREMENTAL_OVERLAP_DAYS)).strftime("%Y-%m-%d"),
            )
            incremental = fetch_requested_history(stock, context, overlap_start, requested_end)
            merged = merge_incremental_history(cached.history, incremental, requested_start, requested_end)
            if merged is not None:
                write_history_cache(
                    path,
                    metadata,
                    merged,
                    fetched_start=requested_start,
                    fetched_through=requested_end,
                )
                return merged, "incremental"

    history = fetch_requested_history(stock, context, requested_start, requested_end)
    write_history_cache(
        path,
        metadata,
        history,
        fetched_start=requested_start,
        fetched_through=requested_end,
    )
    return history, "refresh" if cached is not None else "miss"


def fetch_requested_history(
    stock: StockItem,
    context: dict[str, Any],
    start_date: str,
    end_date: str,
) -> StockHistory:
    history = fetch_stock_history(
        stock,
        start_date.replace("-", ""),
        end_date.replace("-", ""),
        "" if context["adjust"] == "none" else context["adjust"],
        context["historySource"],
        float(context["sleep"]),
        float(context["requestTimeout"]),
        int(context["requestAttempts"]),
        bool(context["allowProviderFallback"]),
    )
    if history.bars.empty:
        raise RuntimeError("provider returned no normalized bars")
    return history


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
        "adjust": context["adjust"],
        "historySource": context["historySource"],
        "allowProviderFallback": context["allowProviderFallback"],
        "akshareVersion": akshare_version,
    }


def history_cache_path(cache_dir: Path, metadata: dict[str, Any]) -> Path:
    encoded = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    fingerprint = hashlib.sha256(encoded).hexdigest()[:20]
    return cache_dir / f"{metadata['code']}-{fingerprint}.json.gz"


def read_history_cache(path: Path, expected_metadata: dict[str, Any]) -> StockHistory | None:
    entry = read_history_cache_entry(path, expected_metadata)
    return entry.history if entry is not None else None


def read_history_cache_entry(path: Path, expected_metadata: dict[str, Any]) -> HistoryCacheEntry | None:
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("metadata") != expected_metadata or not isinstance(payload.get("bars"), list) or not payload["bars"]:
            return None
        coverage = payload.get("coverage")
        if not isinstance(coverage, dict):
            return None
        fetched_start = normalize_cache_date(coverage.get("startDate"))
        fetched_through = normalize_cache_date(coverage.get("throughDate"))
        if fetched_start > fetched_through:
            return None
        bars = pd.DataFrame(payload["bars"])
        required = {"date", "open", "close", "high", "low", "volume", "amount"}
        if not required.issubset(bars.columns):
            return None
        if not cached_bars_are_valid(bars, fetched_start, fetched_through):
            path.unlink(missing_ok=True)
            return None
        stock = StockItem(expected_metadata["code"], expected_metadata["name"], expected_metadata["industry"])
        provider = payload.get("provider")
        if provider not in {"sina", "eastmoney"}:
            return None
        if not expected_metadata["allowProviderFallback"] and provider != expected_metadata["historySource"]:
            return None
        return HistoryCacheEntry(
            history=StockHistory(stock=stock, bars=bars, provider=provider),
            fetched_start=fetched_start,
            fetched_through=fetched_through,
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def migrate_legacy_history_cache(
    cache_dir: Path,
    target_path: Path,
    expected_metadata: dict[str, Any],
) -> HistoryCacheEntry | None:
    candidates: list[HistoryCacheEntry] = []
    source_paths: list[Path] = []
    legacy_paths = list(cache_dir.glob(f"{expected_metadata['code']}-*.json.gz"))
    migration_root = cache_dir.parent.parent / "akshare-history-v1"
    if migration_root.exists():
        legacy_paths.extend(migration_root.rglob(f"{expected_metadata['code']}-*.json.gz"))
    for legacy_path in legacy_paths:
        if legacy_path == target_path:
            continue
        try:
            with gzip.open(legacy_path, "rt", encoding="utf-8") as handle:
                payload = json.load(handle)
            legacy = payload.get("metadata")
            if not isinstance(legacy, dict) or legacy.get("version") != 1:
                continue
            comparable_keys = [
                "code",
                "name",
                "industry",
                "adjust",
                "historySource",
                "allowProviderFallback",
                "akshareVersion",
            ]
            if any(legacy.get(key) != expected_metadata.get(key) for key in comparable_keys):
                continue
            fetched_start = normalize_cache_date(legacy.get("startDate"))
            fetched_through = normalize_cache_date(legacy.get("endDate"))
            bars_payload = payload.get("bars")
            if not isinstance(bars_payload, list) or not bars_payload:
                continue
            bars = pd.DataFrame(bars_payload)
            required = {"date", "open", "close", "high", "low", "volume", "amount"}
            if not required.issubset(bars.columns) or not cached_bars_are_valid(bars, fetched_start, fetched_through):
                continue
            provider = payload.get("provider")
            if provider not in {"sina", "eastmoney"}:
                continue
            if not expected_metadata["allowProviderFallback"] and provider != expected_metadata["historySource"]:
                continue
            stock = StockItem(expected_metadata["code"], expected_metadata["name"], expected_metadata["industry"])
            candidates.append(HistoryCacheEntry(StockHistory(stock, bars, provider), fetched_start, fetched_through))
            source_paths.append(legacy_path)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue

    if not candidates:
        return None
    newest_index = max(range(len(candidates)), key=lambda index: candidates[index].fetched_through)
    selected = candidates[newest_index]
    write_history_cache(
        target_path,
        expected_metadata,
        selected.history,
        fetched_start=selected.fetched_start,
        fetched_through=selected.fetched_through,
    )
    source_paths[newest_index].unlink(missing_ok=True)
    return selected


def write_history_cache(
    path: Path,
    metadata: dict[str, Any],
    history: StockHistory,
    fetched_start: str | None = None,
    fetched_through: str | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if history.bars.empty:
        raise ValueError("Cannot cache an empty history.")
    fetched_start = normalize_cache_date(fetched_start or str(history.bars.iloc[0]["date"]))
    fetched_through = normalize_cache_date(fetched_through or str(history.bars.iloc[-1]["date"]))
    if not cached_bars_are_valid(history.bars, fetched_start, fetched_through):
        raise ValueError("Refusing to cache malformed or out-of-range history bars.")
    bars = json.loads(history.bars.to_json(orient="records", force_ascii=False))
    payload = {
        "metadata": metadata,
        "coverage": {"startDate": fetched_start, "throughDate": fetched_through},
        "provider": history.provider,
        "bars": bars,
    }
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as raw:
        temporary_path = Path(raw.name)
    try:
        with gzip.open(temporary_path, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def cached_bars_are_valid(bars: pd.DataFrame, fetched_start: str, fetched_through: str) -> bool:
    if bars.empty:
        return False
    dates = bars["date"].astype(str)
    parsed_dates = pd.to_datetime(dates, errors="coerce")
    if (
        parsed_dates.isna().any()
        or parsed_dates.dt.strftime("%Y-%m-%d").tolist() != dates.tolist()
        or dates.duplicated().any()
        or dates.tolist() != sorted(dates.tolist())
    ):
        return False
    if dates.iloc[0] < fetched_start or dates.iloc[-1] > fetched_through:
        return False
    numeric = bars[["open", "close", "high", "low", "volume", "amount"]].apply(pd.to_numeric, errors="coerce")
    return bool(
        numeric.notna().all().all()
        and np.isfinite(numeric.to_numpy()).all()
        and (numeric[["open", "close", "high", "low"]] > 0).all().all()
        and (numeric[["volume", "amount"]] >= 0).all().all()
        and (numeric["high"] >= numeric[["open", "close", "low"]].max(axis=1)).all()
        and (numeric["low"] <= numeric[["open", "close", "high"]].min(axis=1)).all()
    )


def merge_incremental_history(
    cached: StockHistory,
    incremental: StockHistory,
    requested_start: str,
    requested_end: str,
) -> StockHistory | None:
    if cached.provider != incremental.provider:
        return None
    cached_bars = cached.bars.copy()
    incremental_bars = incremental.bars.copy()
    overlap = sorted(set(cached_bars["date"]).intersection(incremental_bars["date"]))
    if not overlap:
        return None
    cached_overlap = cached_bars.set_index("date").loc[overlap, ["open", "close", "high", "low"]].astype(float)
    incremental_overlap = incremental_bars.set_index("date").loc[overlap, ["open", "close", "high", "low"]].astype(float)
    if not np.allclose(cached_overlap.to_numpy(), incremental_overlap.to_numpy(), rtol=1e-9, atol=1e-9):
        # QFQ/HFQ history may be rebased after a corporate action. Mixing two
        # adjustment bases corrupts indicators, so force a complete range fetch.
        return None

    merged = pd.concat([cached_bars, incremental_bars], ignore_index=True)
    merged = merged.drop_duplicates(subset=["date"], keep="last").sort_values("date")
    merged = merged[(merged["date"] >= requested_start) & (merged["date"] <= requested_end)].reset_index(drop=True)
    if not cached_bars_are_valid(merged, requested_start, requested_end):
        return None
    return StockHistory(stock=cached.stock, bars=merged, provider=incremental.provider)


def slice_history(history: StockHistory, requested_start: str, requested_end: str) -> StockHistory:
    bars = history.bars[
        (history.bars["date"] >= requested_start) & (history.bars["date"] <= requested_end)
    ].copy().reset_index(drop=True)
    if bars.empty:
        raise RuntimeError("cached history does not contain the requested range")
    return StockHistory(stock=history.stock, bars=bars, provider=history.provider)


def normalize_cache_date(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Cache coverage dates must be strings.")
    return datetime.strptime(value.replace("-", ""), "%Y%m%d").strftime("%Y-%m-%d")


if __name__ == "__main__":
    main()
