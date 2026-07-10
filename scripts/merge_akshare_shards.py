#!/usr/bin/env python3
"""Validate and merge all AkShare shards into the existing publish bundle format."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
from typing import Any

try:
    from scripts.build_akshare_shard import SHARD_VERSION, select_shard_stocks
    from scripts.build_akshare_snapshot import (
        CACHE_KEY,
        CHINA_TZ,
        StockItem,
        assemble_snapshot,
        manifest_source,
        require_minimum_coverage,
        write_json,
    )
    from scripts.prepare_akshare_context import load_and_validate_context
except ModuleNotFoundError:  # Direct `python scripts/...py` execution.
    from build_akshare_shard import SHARD_VERSION, select_shard_stocks  # type: ignore[no-redef]
    from build_akshare_snapshot import (  # type: ignore[no-redef]
        CACHE_KEY,
        CHINA_TZ,
        StockItem,
        assemble_snapshot,
        manifest_source,
        require_minimum_coverage,
        write_json,
    )
    from prepare_akshare_context import load_and_validate_context  # type: ignore[no-redef]


def main() -> None:
    args = parse_args()
    context = load_and_validate_context(args.context)
    shard_paths = sorted(Path(args.shard_dir).rglob("shard-*.json"))
    if not shard_paths:
        raise SystemExit(f"No shard JSON files found below {args.shard_dir}.")
    shards = [json.loads(path.read_text(encoding="utf-8")) for path in shard_paths]
    summary = merge_shards(
        context,
        shards,
        Path(args.output),
        Path(args.close_output),
        Path(args.calendar_output),
        Path(args.artifact_dir),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge validated AkShare shard outputs.")
    parser.add_argument("--context", required=True)
    parser.add_argument("--shard-dir", required=True)
    parser.add_argument("--output", default="data/latest.json")
    parser.add_argument("--close-output", default="data/market-close.json")
    parser.add_argument("--calendar-output", default="data/trading-calendar.json")
    parser.add_argument("--artifact-dir", default="data/publish")
    return parser.parse_args()


def merge_shards(
    context: dict[str, Any],
    shards: list[dict[str, Any]],
    output_path: Path,
    close_output_path: Path,
    calendar_output_path: Path,
    artifact_dir: Path,
    now: datetime | None = None,
) -> dict[str, Any]:
    validate_shards(context, shards)
    now = now or datetime.now(CHINA_TZ)
    stock_codes = {str(stock["code"]) for stock in context["stocks"]}
    history_success_count = sum(int(shard["historySuccessCount"]) for shard in shards)
    history_success_rate = require_minimum_coverage(
        "successful sharded history fetches",
        history_success_count,
        context["stockCount"],
    )
    provider_counts: Counter[str] = Counter()
    for shard in shards:
        provider_counts.update(shard["providerCounts"])
    cache_hit_count = sum(int(shard["cacheHitCount"]) for shard in shards)

    if context["allowProviderFallback"]:
        source_label = (
            "AkShare 日线（新浪优先，东财备用）"
            if context["historySource"] == "sina"
            else "AkShare 日线（东财优先，新浪备用）"
        )
    else:
        source_label = "AkShare 日线（新浪）" if context["historySource"] == "sina" else "AkShare 日线（东财）"
    common_meta = {
        "scanLimit": context["limit"],
        "stockCount": context["stockCount"],
        "universeSource": context["universeSource"],
        "historySource": context["historySource"],
        "historyProviderCounts": dict(sorted(provider_counts.items())),
        "historySuccessCount": history_success_count,
        "historySuccessRate": history_success_rate,
        "failureCount": context["stockCount"] - history_success_count,
        "buildMode": context["buildMode"],
        "perBoardLimit": context["perBoard"],
        "requiredHistoryCodeCount": context["requiredHistoryCodeCount"],
        "shardCount": context["shardCount"],
        "historyCacheHitCount": cache_hit_count,
        "runContextHash": context["contextHash"],
    }

    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, str]] = []
    snapshots: dict[str, dict[str, Any]] = {}
    close_tables: dict[str, dict[str, Any]] = {}
    date_summaries: list[dict[str, Any]] = []
    for target in context["targets"]:
        rows: list[dict[str, Any]] = []
        closes: dict[str, float] = {}
        baseline_closes: dict[str, dict[str, float]] = {}
        for shard in shards:
            date_payload = shard["dates"][target]
            rows.extend(date_payload["rows"])
            merge_unique_map(closes, date_payload["closes"], f"{target} closes")
            for baseline_date, values in date_payload["baselineCloses"].items():
                target_map = baseline_closes.setdefault(baseline_date, {})
                merge_unique_map(target_map, values, f"{target} baseline {baseline_date}")

        exact_close_count = len(closes)
        exact_close_coverage = require_minimum_coverage(
            f"sharded exact-date closes for {target}",
            exact_close_count,
            context["stockCount"],
        )
        artifact_source = context["targetSources"][target]
        snapshot = assemble_snapshot(
            rows,
            context["perBoard"],
            source_label,
            {
                **common_meta,
                "snapshotSource": artifact_source,
                "exactCloseCount": exact_close_count,
                "exactCloseCoverage": exact_close_coverage,
            },
            target,
        )
        close_table = {
            "marketDate": target,
            "closes": dict(sorted(closes.items())),
            "baselineCloses": {
                date: dict(sorted(values.items()))
                for date, values in sorted(baseline_closes.items())
            },
            "adjustmentBasis": {
                "mode": context["adjust"],
                "asOf": max(context["targets"]),
            },
            "updatedAt": now.isoformat(),
            "adjust": context["adjust"],
            "missingCodes": sorted(stock_codes - set(closes)),
        }
        snapshot_path = artifact_dir / f"history-snapshot-{target}.json"
        close_path = artifact_dir / f"market-close-{target}.json"
        write_json(snapshot_path, snapshot)
        write_json(close_path, close_table)
        artifacts.append(
            {
                "date": target,
                "source": artifact_source,
                "snapshotPath": str(snapshot_path),
                "closePath": str(close_path),
            }
        )
        snapshots[target] = snapshot
        close_tables[target] = close_table
        date_summaries.append(
            {
                "date": target,
                "source": artifact_source,
                "closeCount": exact_close_count,
                "closeCoverage": exact_close_coverage,
                "rowCount": sum(len(board["rows"]) for board in snapshot["boards"]),
            }
        )

    latest_target = max(context["targets"])
    write_json(output_path, snapshots[latest_target])
    write_json(close_output_path, close_tables[latest_target])
    write_json(calendar_output_path, context["calendar"])
    write_json(
        artifact_dir / "manifest.json",
        {
            "version": 1,
            "generatedAt": now.isoformat(),
            "source": manifest_source(artifacts),
            "calendarPath": str(calendar_output_path),
            "contextHash": context["contextHash"],
            "shardCount": context["shardCount"],
            "artifacts": artifacts,
        },
    )
    return {
        "contextHash": context["contextHash"],
        "shards": context["shardCount"],
        "stockCount": context["stockCount"],
        "historySuccessCount": history_success_count,
        "historySuccessRate": history_success_rate,
        "cacheHitCount": cache_hit_count,
        "dates": date_summaries,
        "manifest": str(artifact_dir / "manifest.json"),
        "kvKey": CACHE_KEY,
    }


def validate_shards(context: dict[str, Any], shards: list[dict[str, Any]]) -> None:
    shard_count = context["shardCount"]
    if len(shards) != shard_count:
        raise ValueError(f"Expected {shard_count} shards, received {len(shards)}.")
    indexes = [shard.get("shardIndex") for shard in shards]
    if sorted(indexes) != list(range(shard_count)):
        raise ValueError("Shard indexes must cover the prepared range exactly once.")

    all_stocks = [StockItem(**item) for item in context["stocks"]]
    seen_codes: set[str] = set()
    for shard in shards:
        index = shard["shardIndex"]
        if (
            shard.get("version") != SHARD_VERSION
            or shard.get("contextHash") != context["contextHash"]
            or shard.get("shardCount") != shard_count
        ):
            raise ValueError(f"Shard {index} does not belong to this run context.")
        expected_codes = [stock.code for stock in select_shard_stocks(all_stocks, index, shard_count)]
        if shard.get("stockCodes") != expected_codes or shard.get("stockCount") != len(expected_codes):
            raise ValueError(f"Shard {index} stock assignment does not match the prepared universe.")
        overlap = seen_codes.intersection(expected_codes)
        if overlap:
            raise ValueError(f"Shard {index} overlaps prior shards: {sorted(overlap)[:3]}.")
        seen_codes.update(expected_codes)

        success_codes = shard.get("successCodes")
        failures = shard.get("failures")
        if not isinstance(success_codes, list) or len(success_codes) != shard.get("historySuccessCount"):
            raise ValueError(f"Shard {index} has inconsistent success counts.")
        if len(success_codes) != len(set(success_codes)) or not set(success_codes).issubset(expected_codes):
            raise ValueError(f"Shard {index} has invalid success codes.")
        if not isinstance(failures, list):
            raise ValueError(f"Shard {index} failures are invalid.")
        failure_codes = [failure.get("code") for failure in failures]
        if len(failure_codes) != len(set(failure_codes)) or set(failure_codes) != set(expected_codes) - set(success_codes):
            raise ValueError(f"Shard {index} failures do not account for its unsuccessful stocks.")
        if sum(shard.get("providerCounts", {}).values()) != len(success_codes):
            raise ValueError(f"Shard {index} provider counts do not match successes.")
        if set(shard.get("dates", {})) != set(context["targets"]):
            raise ValueError(f"Shard {index} dates do not match the prepared targets.")
        for target, payload in shard["dates"].items():
            if not isinstance(payload.get("rows"), list) or not isinstance(payload.get("closes"), dict):
                raise ValueError(f"Shard {index}/{target} payload is invalid.")
            if not set(payload["closes"]).issubset(success_codes):
                raise ValueError(f"Shard {index}/{target} closes contain unsuccessful codes.")
            if any(str(row.get("code")) not in expected_codes for row in payload["rows"]):
                raise ValueError(f"Shard {index}/{target} rows escape the shard assignment.")
            baselines = payload.get("baselineCloses")
            if not isinstance(baselines, dict) or any(not set(values).issubset(success_codes) for values in baselines.values()):
                raise ValueError(f"Shard {index}/{target} baselines are invalid.")

    if seen_codes != {stock.code for stock in all_stocks}:
        raise ValueError("Merged shard assignments do not cover the prepared universe.")


def merge_unique_map(destination: dict[str, float], source: dict[str, float], label: str) -> None:
    overlap = set(destination).intersection(source)
    if overlap:
        raise ValueError(f"Duplicate codes in {label}: {sorted(overlap)[:3]}.")
    destination.update(source)


if __name__ == "__main__":
    main()
