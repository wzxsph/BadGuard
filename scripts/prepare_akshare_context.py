#!/usr/bin/env python3
"""Prepare one immutable AkShare run context for parallel shard workers."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
from typing import Any

try:
    from scripts.build_akshare_snapshot import (
        CHINA_TZ,
        DEFAULT_PER_BOARD,
        StockItem,
        calendar_publication_dates,
        load_required_codes,
        load_stock_universe,
        load_trading_calendar,
        normalize_date_arg,
        resolve_target_dates,
        source_for_target,
        validate_production_universe,
        write_json,
    )
    from scripts.http_timeout import install_default_requests_timeout
    from scripts.universe_manifest import (
        DEFAULT_MAX_UNIVERSE_DELTA_RATE,
        load_optional_universe_manifest,
        reconcile_universe_manifest,
    )
except ModuleNotFoundError:  # Direct `python scripts/...py` execution.
    from build_akshare_snapshot import (  # type: ignore[no-redef]
        CHINA_TZ,
        DEFAULT_PER_BOARD,
        StockItem,
        calendar_publication_dates,
        load_required_codes,
        load_stock_universe,
        load_trading_calendar,
        normalize_date_arg,
        resolve_target_dates,
        source_for_target,
        validate_production_universe,
        write_json,
    )
    from http_timeout import install_default_requests_timeout  # type: ignore[no-redef]
    from universe_manifest import (  # type: ignore[no-redef]
        DEFAULT_MAX_UNIVERSE_DELTA_RATE,
        load_optional_universe_manifest,
        reconcile_universe_manifest,
    )


CONTEXT_VERSION = 1


def main() -> None:
    args = parse_args()
    context = prepare_context(args)
    write_json(Path(args.output), context)
    write_json(Path(args.calendar_output), context["calendar"])
    print(
        f"Prepared context {context['contextHash'][:12]} with {context['stockCount']} stocks, "
        f"{len(context['targets'])} target date(s), {context['universeStaleCount']} stale members, "
        f"and {context['shardCount']} shards.",
        flush=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare the stable universe and dates for one sharded AkShare run.")
    parser.add_argument("--output", default="data/run-context.json")
    parser.add_argument("--calendar-output", default="data/trading-calendar.json")
    parser.add_argument("--prior-universe")
    parser.add_argument("--universe-manifest-output", default="data/universe-manifest.json")
    parser.add_argument(
        "--max-universe-delta-rate",
        type=float,
        default=float(os.environ.get("UNIVERSE_DELTA_THRESHOLD", DEFAULT_MAX_UNIVERSE_DELTA_RATE)),
    )
    parser.add_argument("--required-codes")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--target-date")
    parser.add_argument("--backfill-start")
    parser.add_argument("--backfill-end")
    parser.add_argument("--include-live-target", action="store_true")
    parser.add_argument("--lookback-days", type=int, default=220)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--per-board", type=int, default=DEFAULT_PER_BOARD)
    parser.add_argument("--max-workers", type=int, default=8)
    parser.add_argument("--sleep", type=float, default=0.02)
    parser.add_argument("--request-timeout", type=float, default=20.0)
    parser.add_argument("--request-attempts", type=int, default=2)
    parser.add_argument("--history-retry-rounds", type=int, default=4)
    parser.add_argument("--history-retry-backoff-seconds", type=float, default=3.0)
    parser.add_argument("--max-consecutive-failures", type=int, default=12)
    parser.add_argument("--soft-deadline-minutes", type=float, default=60.0)
    parser.add_argument("--adjust", default="qfq", choices=["", "qfq", "hfq"])
    parser.add_argument("--include-st", action="store_true")
    parser.add_argument("--universe-source", default="code-list", choices=["code-list", "realtime"])
    parser.add_argument("--history-source", default="sina", choices=["sina", "eastmoney"])
    parser.add_argument(
        "--allow-provider-fallback",
        action="store_true",
        help="Try the secondary provider after the preferred provider exhausts retries.",
    )
    parser.add_argument("--skip-industry-map", action="store_true")
    parser.add_argument("--build-mode", default="local", choices=["production", "staging", "local"])
    parser.add_argument("--snapshot-source", default="live", choices=["live", "backfill"])
    parser.add_argument("--shard-count", type=int, default=8)
    return parser.parse_args()


def prepare_context(args: argparse.Namespace, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(CHINA_TZ)
    if args.shard_count <= 0:
        raise SystemExit("shard-count must be positive.")
    if args.request_timeout <= 0:
        raise SystemExit("request-timeout must be positive.")
    if (
        args.request_attempts <= 0
        or args.history_retry_rounds <= 0
        or args.history_retry_backoff_seconds < 0
        or args.max_consecutive_failures <= 0
        or args.soft_deadline_minutes <= 0
    ):
        raise SystemExit(
            "request-attempts, history-retry-rounds, max-consecutive-failures, and "
            "soft-deadline-minutes must be positive; history-retry-backoff-seconds cannot be negative."
        )
    install_default_requests_timeout(args.request_timeout)

    calendar_dates = load_trading_calendar()
    published_calendar_dates = calendar_publication_dates(calendar_dates)
    targets = resolve_target_dates(args, calendar_dates, now)
    if not targets:
        raise SystemExit("No exchange trading dates matched the requested range.")

    end_date = max(targets).replace("-", "")
    start_date = args.start_date or (
        datetime.strptime(min(targets), "%Y-%m-%d") - timedelta(days=args.lookback_days)
    ).strftime("%Y%m%d")
    # Reject malformed explicit dates before they become part of the cache identity.
    normalize_date_arg(start_date)
    normalize_date_arg(end_date)

    required_codes = load_required_codes(args.required_codes)
    validate_production_universe(
        args.build_mode,
        args.universe_source,
        args.universe_source,
        args.limit,
        args.per_board,
    )
    candidate_stocks, actual_universe_source = load_stock_universe(
        args.limit,
        args.include_st,
        args.universe_source,
        set(),
    )
    prior_manifest = (
        load_optional_universe_manifest(args.prior_universe)
        if args.build_mode == "production"
        else None
    )
    universe_manifest = reconcile_universe_manifest(
        candidate_stocks,
        actual_universe_source,
        now,
        prior_manifest,
        args.max_universe_delta_rate,
    )
    write_json(Path(args.universe_manifest_output), universe_manifest)
    manifest_stocks = [
        StockItem(member["code"], member["name"], member["industry"])
        for member in universe_manifest["members"]
    ]
    manifest_codes = {stock.code for stock in manifest_stocks}
    required_only_codes = sorted(required_codes - manifest_codes)
    stocks = [
        *manifest_stocks,
        *(StockItem(code, code, "未分类") for code in required_only_codes),
    ]
    validate_production_universe(
        args.build_mode,
        args.universe_source,
        actual_universe_source,
        args.limit,
        args.per_board,
        len(stocks),
    )
    stocks = sorted(stocks, key=lambda stock: stock.code)
    assert_unique_stock_codes(stocks)

    stable_payload: dict[str, Any] = {
        "version": CONTEXT_VERSION,
        "shardCount": args.shard_count,
        "stocks": [asdict(stock) for stock in stocks],
        "stockCount": len(stocks),
        "requiredHistoryCodeCount": len(required_codes),
        "requiredOnlyCodes": required_only_codes,
        "universeManifestRevision": universe_manifest["revision"],
        "universeManifestMemberCount": universe_manifest["memberCount"],
        "universeStaleCount": universe_manifest["staleCount"],
        "universeStaleCodes": [
            member["code"] for member in universe_manifest["members"] if member["status"] == "stale"
        ],
        "requestedUniverseSource": args.universe_source,
        "universeSource": actual_universe_source,
        "limit": args.limit,
        "perBoard": args.per_board,
        "buildMode": args.build_mode,
        "historySource": args.history_source,
        "adjust": args.adjust or "none",
        "skipIndustryMap": bool(args.skip_industry_map),
        "maxWorkers": args.max_workers,
        "sleep": args.sleep,
        "requestTimeout": args.request_timeout,
        "requestAttempts": args.request_attempts,
        "historyRetryRounds": args.history_retry_rounds,
        "historyRetryBackoffSeconds": args.history_retry_backoff_seconds,
        "maxConsecutiveFailures": args.max_consecutive_failures,
        "softDeadlineMinutes": args.soft_deadline_minutes,
        "allowProviderFallback": bool(args.allow_provider_fallback),
        "startDate": start_date,
        "endDate": end_date,
        "targets": targets,
        "targetSources": {
            target: source_for_target(args, calendar_dates, now, target)
            for target in targets
        },
        "calendar": {
            "version": 1,
            "tradingDates": published_calendar_dates,
        },
    }
    return {
        **stable_payload,
        "contextHash": calculate_context_hash(stable_payload),
        "preparedAt": now.isoformat(),
    }


def calculate_context_hash(context: dict[str, Any]) -> str:
    stable = {
        key: value
        for key, value in context.items()
        if key not in {"contextHash", "preparedAt"}
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_and_validate_context(path: str | Path) -> dict[str, Any]:
    context = json.loads(Path(path).read_text(encoding="utf-8"))
    if context.get("version") != CONTEXT_VERSION:
        raise ValueError(f"Run context must be version {CONTEXT_VERSION}.")
    if context.get("contextHash") != calculate_context_hash(context):
        raise ValueError("Run context hash does not match its contents.")
    if not isinstance(context.get("shardCount"), int) or context["shardCount"] <= 0:
        raise ValueError("Run context shardCount must be positive.")
    if (
        not isinstance(context.get("historyRetryRounds"), int)
        or context["historyRetryRounds"] <= 0
        or not isinstance(context.get("historyRetryBackoffSeconds"), (int, float))
        or context["historyRetryBackoffSeconds"] < 0
    ):
        raise ValueError("Run context history retry settings are invalid.")
    stocks = context.get("stocks")
    if not isinstance(stocks, list) or len(stocks) != context.get("stockCount") or not stocks:
        raise ValueError("Run context stockCount does not match stocks.")
    stock_items = [StockItem(str(item["code"]), str(item["name"]), str(item["industry"])) for item in stocks]
    assert_unique_stock_codes(stock_items)
    if sorted(stock.code for stock in stock_items) != [stock.code for stock in stock_items]:
        raise ValueError("Run context stocks must be sorted by code.")
    stale_codes = context.get("universeStaleCodes")
    required_only_codes = context.get("requiredOnlyCodes")
    if (
        not isinstance(context.get("universeManifestRevision"), str)
        or len(context["universeManifestRevision"]) != 16
        or not isinstance(context.get("universeManifestMemberCount"), int)
        or not isinstance(stale_codes, list)
        or not isinstance(required_only_codes, list)
        or len(stale_codes) != context.get("universeStaleCount")
        or not set(stale_codes).issubset({stock.code for stock in stock_items})
        or not set(required_only_codes).issubset({stock.code for stock in stock_items})
    ):
        raise ValueError("Run context universe manifest metadata is invalid.")
    targets = context.get("targets")
    target_sources = context.get("targetSources")
    calendar = context.get("calendar")
    if not isinstance(targets, list) or not targets or sorted(set(targets)) != targets:
        raise ValueError("Run context targets must be a sorted unique non-empty list.")
    if not isinstance(target_sources, dict) or set(target_sources) != set(targets):
        raise ValueError("Run context targetSources do not match targets.")
    if not isinstance(calendar, dict) or calendar.get("version") != 1 or not isinstance(calendar.get("tradingDates"), list):
        raise ValueError("Run context calendar is invalid.")
    if not set(targets).issubset(calendar["tradingDates"]):
        raise ValueError("Run context targets are absent from its exchange calendar.")
    return context


def assert_unique_stock_codes(stocks: list[StockItem]) -> None:
    codes = [stock.code for stock in stocks]
    if len(codes) != len(set(codes)) or any(len(code) != 6 or not code.isdigit() for code in codes):
        raise ValueError("Stock universe must contain unique six-digit codes.")


if __name__ == "__main__":
    main()
