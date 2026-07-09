#!/usr/bin/env python3
"""Build a Cloudflare KV-ready technical signal snapshot with AkShare."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

try:
    import akshare as ak
except ImportError as exc:  # pragma: no cover - friendly CLI failure
    raise SystemExit("AkShare is not installed. Run: pip install -r requirements.txt") from exc


CACHE_KEY = "latest-signal-snapshot"
CHINA_TZ = ZoneInfo("Asia/Shanghai")
OBSERVATION_SIGNAL_IDS = {"low-rebound", "trend-strength", "oversold-repair"}
EASTMONEY_CLIST_URL = "https://82.push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
EASTMONEY_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

SIGNAL_DEFINITIONS = [
    {
        "id": "low-rebound",
        "title": "低位反弹观察",
        "signalName": "日线KDJ低位金叉 + 成交量放大",
        "stance": "观察",
        "summary": "KDJ在20附近或以下形成金叉，同时成交量明显高于近期均值。",
    },
    {
        "id": "trend-strength",
        "title": "趋势转强观察",
        "signalName": "MACD金叉 + 站回5/10日均线",
        "stance": "观察",
        "summary": "MACD由弱转强，收盘价重新站回5日与10日均线。",
    },
    {
        "id": "oversold-repair",
        "title": "超跌修复观察",
        "signalName": "RSI低位回升 + BOLL下轨收回",
        "stance": "观察",
        "summary": "RSI从低位回升，股价从BOLL下轨附近重新收回。",
    },
    {
        "id": "risk-filter",
        "title": "风险过滤榜",
        "signalName": "跌破均线 / 放量下跌 / KDJ高位死叉",
        "stance": "谨慎",
        "summary": "近期均线结构走弱、放量下跌，或KDJ在高位出现死叉。",
    },
]

PHILOSOPHY = (
    "技术指标不是预测未来，而是把价格、成交量与波动留下的痕迹变得更容易观察。"
    "看懂趋势，比预测涨跌更重要。"
)

DISCLAIMERS = [
    "本页面只描述历史交易数据形成的技术状态，不构成投资建议。",
    "所有信号仅标记为观察或谨慎，需要结合基本面、流动性与个人风险承受能力判断。",
]


@dataclass(frozen=True)
class StockItem:
    code: str
    name: str
    industry: str


def main() -> None:
    args = parse_args()
    end_date = args.end_date or datetime.now(CHINA_TZ).strftime("%Y%m%d")
    start_date = args.start_date or (datetime.now(CHINA_TZ) - timedelta(days=args.lookback_days)).strftime("%Y%m%d")

    stocks, actual_universe_source = load_stock_universe(args.limit, args.include_st, args.universe_source)
    print(f"Loaded {len(stocks)} stocks; fetching daily bars from {start_date} to {end_date}.")

    rows: list[dict[str, Any]] = []
    failures: list[str] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = {
            executor.submit(fetch_and_score_stock, stock, start_date, end_date, args.adjust, args.history_source, args.sleep): stock
            for stock in stocks
        }

        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            stock = futures[future]
            try:
                rows.extend(future.result())
            except Exception as exc:  # pragma: no cover - network/provider variability
                failures.append(f"{stock.code} {stock.name}: {exc}")

            if index % 100 == 0:
                print(f"Processed {index}/{len(stocks)} stocks; signals={len(rows)}; failures={len(failures)}")

    if stocks and len(failures) == len(stocks):
        raise SystemExit(f"All {len(stocks)} stock history requests failed; snapshot was not written.")

    if rows and not args.skip_industry_map:
        enrich_row_industries(rows, end_date)

    source_label = "AkShare 日线（新浪优先，东财备用）" if args.history_source == "sina" else "AkShare 日线（东财优先，新浪备用）"
    snapshot = assemble_snapshot(
        rows,
        args.per_board,
        source_label,
        {
            "scanLimit": args.limit,
            "stockCount": len(stocks),
            "universeSource": actual_universe_source,
            "historySource": args.history_source,
            "failureCount": len(failures),
            "buildMode": args.build_mode,
        },
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"Wrote {output_path} with {len(snapshot['topRows'])} ranked rows.")
    print(f"KV key: {CACHE_KEY}")
    if failures:
        print(f"Skipped {len(failures)} failed symbols. First failure: {failures[0]}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the daily technical signal snapshot from AkShare.")
    parser.add_argument("--output", default="data/latest.json", help="Output snapshot JSON path.")
    parser.add_argument("--start-date", help="AkShare start date, e.g. 20260101.")
    parser.add_argument("--end-date", help="AkShare end date, e.g. 20260709.")
    parser.add_argument("--lookback-days", type=int, default=220, help="Calendar days to fetch when start-date is omitted.")
    parser.add_argument("--limit", type=int, default=0, help="Limit the stock universe; 0 means all.")
    parser.add_argument("--per-board", type=int, default=80, help="Maximum rows retained per board.")
    parser.add_argument("--max-workers", type=int, default=4, help="Concurrent AkShare history requests.")
    parser.add_argument("--sleep", type=float, default=0.05, help="Seconds to sleep after each stock request.")
    parser.add_argument("--adjust", default="qfq", choices=["", "qfq", "hfq"], help="AkShare adjustment mode.")
    parser.add_argument("--include-st", action="store_true", help="Include ST and delisting-risk names.")
    parser.add_argument("--universe-source", default="code-list", choices=["code-list", "realtime"], help="Use daily code list by default; realtime may depend on Eastmoney availability.")
    parser.add_argument("--history-source", default="sina", choices=["sina", "eastmoney"], help="Daily history source preference.")
    parser.add_argument("--skip-industry-map", action="store_true", help="Skip post-signal industry lookup and use 未分类.")
    parser.add_argument("--build-mode", default="local", choices=["production", "staging", "local"], help="Snapshot publishing mode metadata.")
    return parser.parse_args()


def load_stock_universe(limit: int, include_st: bool, universe_source: str) -> tuple[list[StockItem], str]:
    actual_source = universe_source
    spot_df: pd.DataFrame | None = None

    if universe_source == "realtime":
        try:
            spot_df = call_with_retry(ak.stock_zh_a_spot_em, "stock_zh_a_spot_em")
        except RuntimeError as exc:
            print(f"AkShare realtime universe unavailable, trying Eastmoney direct clist: {exc}")
            try:
                spot_df = load_eastmoney_realtime_table(limit)
                actual_source = "realtime"
            except RuntimeError as direct_exc:
                print(f"Eastmoney direct clist unavailable, falling back to stock_info_a_code_name: {direct_exc}")

    if spot_df is None:
        try:
            spot_df = load_code_name_table()
            actual_source = "code-list"
        except RuntimeError as exc:
            if universe_source == "realtime":
                raise RuntimeError(f"Unable to load realtime or code-list universe: {exc}") from exc
            print(f"AkShare code-list universe unavailable, trying Eastmoney direct clist: {exc}")
            spot_df = load_eastmoney_realtime_table(limit)
            actual_source = "realtime"

    required_columns = {"代码", "名称"}
    missing = required_columns - set(spot_df.columns)
    if missing:
        raise RuntimeError(f"stock_zh_a_spot_em missing columns: {', '.join(sorted(missing))}")

    spot_df = spot_df.copy()
    spot_df["代码"] = spot_df["代码"].astype(str).str.zfill(6)
    spot_df["名称"] = spot_df["名称"].astype(str)

    if "成交额" in spot_df.columns:
        spot_df["成交额"] = pd.to_numeric(spot_df["成交额"], errors="coerce").fillna(0)
        spot_df = spot_df.sort_values("成交额", ascending=False)

    if not include_st:
        spot_df = spot_df[~spot_df["名称"].str.contains("ST|退", regex=True, na=False)]

    if limit > 0:
        spot_df = spot_df.head(limit)

    stocks = [
        StockItem(
            code=row["代码"],
            name=row["名称"],
            industry="未分类",
        )
        for _, row in spot_df.iterrows()
    ]
    return stocks, actual_source


def load_code_name_table() -> pd.DataFrame:
    code_df = call_with_retry(ak.stock_info_a_code_name, "stock_info_a_code_name")
    return code_df.rename(columns={"code": "代码", "name": "名称"})


def load_eastmoney_realtime_table(limit: int) -> pd.DataFrame:
    rows = call_with_retry(lambda: request_eastmoney_realtime_rows(limit), "eastmoney_clist")
    frame = pd.DataFrame(rows)
    if frame.empty:
        raise RuntimeError("eastmoney_clist returned no rows")

    return frame.rename(columns={"f12": "代码", "f14": "名称", "f6": "成交额"})[["代码", "名称", "成交额"]]


def request_eastmoney_realtime_rows(limit: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    page_size = 100
    target = limit if limit > 0 else 6000
    max_pages = max(1, math.ceil(target / page_size))

    for page in range(1, max_pages + 1):
        params = {
            "pn": page,
            "pz": page_size,
            "po": 1,
            "np": 1,
            "ut": "bd1d9ddb04089700cf9c27f6f7426281",
            "fltt": 2,
            "invt": 2,
            "fid": "f6",
            "fs": EASTMONEY_A_SHARE_FS,
            "fields": "f12,f14,f6",
        }
        request = Request(
            f"{EASTMONEY_CLIST_URL}?{urlencode(params)}",
            headers={"User-Agent": EASTMONEY_USER_AGENT, "Referer": "https://quote.eastmoney.com/center/gridlist.html"},
        )

        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))

        page_rows = (payload.get("data") or {}).get("diff") or []
        if not page_rows:
            break

        rows.extend(page_rows)
        if len(rows) >= target:
            break

    return rows[:limit] if limit > 0 else rows


def fetch_and_score_stock(stock: StockItem, start_date: str, end_date: str, adjust: str, history_source: str, sleep_seconds: float) -> list[dict[str, Any]]:
    hist_df = fetch_history(stock, start_date, end_date, adjust, history_source)
    time.sleep(sleep_seconds)

    bars = normalize_history(hist_df)
    if len(bars) < 30:
        return []

    scored = score_stock(stock, bars)
    return scored


def fetch_history(stock: StockItem, start_date: str, end_date: str, adjust: str, history_source: str) -> pd.DataFrame:
    if history_source == "eastmoney":
        primary, fallback = fetch_eastmoney_history, fetch_sina_history
    else:
        primary, fallback = fetch_sina_history, fetch_eastmoney_history

    try:
        return primary(stock.code, start_date, end_date, adjust)
    except RuntimeError:
        return fallback(stock.code, start_date, end_date, adjust)


def fetch_sina_history(code: str, start_date: str, end_date: str, adjust: str) -> pd.DataFrame:
    return call_with_retry(
        lambda: ak.stock_zh_a_daily(
            symbol=market_symbol(code),
            start_date=start_date,
            end_date=end_date,
            adjust=adjust,
        ),
        f"stock_zh_a_daily:{code}",
    )


def fetch_eastmoney_history(code: str, start_date: str, end_date: str, adjust: str) -> pd.DataFrame:
    return call_with_retry(
        lambda: ak.stock_zh_a_hist(
            symbol=code,
            period="daily",
            start_date=start_date,
            end_date=end_date,
            adjust=adjust,
        ),
        f"stock_zh_a_hist:{code}",
    )


def normalize_history(hist_df: pd.DataFrame) -> pd.DataFrame:
    chinese_columns = {
        "日期": "date",
        "开盘": "open",
        "收盘": "close",
        "最高": "high",
        "最低": "low",
        "成交量": "volume",
        "成交额": "amount",
    }
    english_columns = {
        "date": "date",
        "open": "open",
        "close": "close",
        "high": "high",
        "low": "low",
        "volume": "volume",
        "amount": "amount",
    }

    if set(chinese_columns).issubset(hist_df.columns):
        columns = chinese_columns
    elif set(english_columns).issubset(hist_df.columns):
        columns = english_columns
    else:
        required = set(chinese_columns) | set(english_columns)
        missing = required - set(hist_df.columns)
        raise RuntimeError(f"history data missing OHLCVA columns: {', '.join(sorted(missing))}")

    bars = hist_df.rename(columns=columns)[list(columns.values())].copy()
    bars["date"] = pd.to_datetime(bars["date"]).dt.strftime("%Y-%m-%d")
    for column in ["open", "close", "high", "low", "volume", "amount"]:
        bars[column] = pd.to_numeric(bars[column], errors="coerce")

    return bars.dropna().sort_values("date").reset_index(drop=True)


def score_stock(stock: StockItem, bars: pd.DataFrame) -> list[dict[str, Any]]:
    metrics = add_indicators(bars)
    current = metrics.iloc[-1]
    previous = metrics.iloc[-2]

    required = ["k", "d", "j", "dif", "dea", "histogram", "rsi", "ma5", "ma10", "ma20", "boll_lower", "volume_ratio"]
    if current[required].isna().any() or previous[required].isna().any():
        return []

    rows: list[dict[str, Any]] = []
    change5d = calculate_return(metrics, 5)
    change20d = calculate_return(metrics, 20)

    if is_low_rebound(current, previous):
        rows.append(make_row("low-rebound", stock, current, previous, change5d, change20d, score_low_rebound(current, previous, change5d, change20d)))

    if is_trend_strength(current, previous):
        rows.append(make_row("trend-strength", stock, current, previous, change5d, change20d, score_trend_strength(current, previous, change5d, change20d)))

    if is_oversold_repair(current, previous):
        rows.append(make_row("oversold-repair", stock, current, previous, change5d, change20d, score_oversold_repair(current, previous, change5d, change20d)))

    if is_risk_filter(current, previous):
        rows.append(make_row("risk-filter", stock, current, previous, change5d, change20d, score_risk(current, previous)))

    return rows


def add_indicators(bars: pd.DataFrame) -> pd.DataFrame:
    frame = bars.copy()
    close = frame["close"]
    high = frame["high"]
    low = frame["low"]

    frame["ma5"] = close.rolling(5).mean()
    frame["ma10"] = close.rolling(10).mean()
    frame["ma20"] = close.rolling(20).mean()
    std20 = close.rolling(20).std(ddof=0)
    frame["boll_middle"] = frame["ma20"]
    frame["boll_upper"] = frame["ma20"] + 2 * std20
    frame["boll_lower"] = frame["ma20"] - 2 * std20

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    frame["dif"] = ema12 - ema26
    frame["dea"] = frame["dif"].ewm(span=9, adjust=False).mean()
    frame["histogram"] = frame["dif"] - frame["dea"]

    frame["rsi"] = calculate_rsi(close, 6)
    add_kdj(frame, high, low, close, 9)
    frame["volume_ratio"] = frame["volume"] / frame["volume"].shift(1).rolling(5).mean()

    return frame


def calculate_rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    average_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    average_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = average_gain / average_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    return rsi.fillna(100)


def add_kdj(frame: pd.DataFrame, high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> None:
    lowest = low.rolling(period).min()
    highest = high.rolling(period).max()
    rsv = (close - lowest) / (highest - lowest) * 100
    rsv = rsv.replace([np.inf, -np.inf], np.nan)

    k_values: list[float] = []
    d_values: list[float] = []
    j_values: list[float] = []
    previous_k = 50.0
    previous_d = 50.0

    for value in rsv:
        if math.isnan(value):
            k_values.append(np.nan)
            d_values.append(np.nan)
            j_values.append(np.nan)
            continue

        k = (2 * previous_k + value) / 3
        d = (2 * previous_d + k) / 3
        j = 3 * k - 2 * d
        previous_k = k
        previous_d = d
        k_values.append(k)
        d_values.append(d)
        j_values.append(j)

    frame["k"] = k_values
    frame["d"] = d_values
    frame["j"] = j_values


def is_low_rebound(current: pd.Series, previous: pd.Series) -> bool:
    crossed = previous["k"] <= previous["d"] and current["k"] > current["d"]
    low_area = min(current["k"], current["d"]) <= 28
    return bool(crossed and low_area and current["volume_ratio"] >= 1.2)


def is_trend_strength(current: pd.Series, previous: pd.Series) -> bool:
    macd_crossed = previous["dif"] <= previous["dea"] and current["dif"] > current["dea"]
    back_above_averages = current["close"] >= current["ma5"] and current["close"] >= current["ma10"]
    return bool(macd_crossed and back_above_averages)


def is_oversold_repair(current: pd.Series, previous: pd.Series) -> bool:
    rsi_lifted = previous["rsi"] <= 38 and current["rsi"] > previous["rsi"] + 1.5
    reclaimed_lower_band = previous["close"] <= previous["boll_lower"] * 1.02 and current["close"] >= current["boll_lower"]
    return bool(rsi_lifted and reclaimed_lower_band)


def is_risk_filter(current: pd.Series, previous: pd.Series) -> bool:
    return len(build_risk_tags(current, previous, strict=True)) >= 2


def make_row(
    signal_id: str,
    stock: StockItem,
    current: pd.Series,
    previous: pd.Series,
    change5d: float,
    change20d: float,
    strength: float,
) -> dict[str, Any]:
    definition = next(item for item in SIGNAL_DEFINITIONS if item["id"] == signal_id)
    strict_risk = signal_id == "risk-filter"

    return {
        "code": stock.code,
        "name": stock.name,
        "signalId": signal_id,
        "signalName": definition["signalName"],
        "stance": definition["stance"],
        "triggerDate": str(current["date"]),
        "indicators": {
            "kdj": {"k": rounded(current["k"]), "d": rounded(current["d"]), "j": rounded(current["j"])},
            "macd": {
                "dif": rounded(current["dif"]),
                "dea": rounded(current["dea"]),
                "histogram": rounded(current["histogram"]),
            },
            "rsi": rounded(current["rsi"]),
        },
        "amount": rounded(current["amount"], 0),
        "industry": stock.industry,
        "change5d": rounded(change5d),
        "change20d": rounded(change20d),
        "riskTags": build_risk_tags(current, previous, strict=strict_risk),
        "signalStrength": int(round(clamp(strength, 0, 100))),
    }


def enrich_row_industries(rows: list[dict[str, Any]], end_date: str) -> None:
    codes = sorted({str(row["code"]) for row in rows})
    industry_by_code: dict[str, str] = {}

    for index, code in enumerate(codes, start=1):
        industry_by_code[code] = lookup_cninfo_industry(code, end_date)
        if index % 20 == 0:
            print(f"Resolved industries for {index}/{len(codes)} signal stocks.")
        time.sleep(0.03)

    for row in rows:
        row["industry"] = industry_by_code.get(str(row["code"]), row.get("industry", "未分类"))


def lookup_cninfo_industry(code: str, end_date: str) -> str:
    try:
        industry_df = call_with_retry(
            lambda: ak.stock_industry_change_cninfo(symbol=code, start_date="20000101", end_date=end_date),
            f"stock_industry_change_cninfo:{code}",
            attempts=2,
        )
    except Exception:
        return "未分类"

    if industry_df.empty:
        return "未分类"

    frame = industry_df.copy()
    if "变更日期" in frame.columns:
        frame["变更日期"] = pd.to_datetime(frame["变更日期"], errors="coerce")
        frame = frame.sort_values("变更日期")

    if "分类标准" in frame.columns:
        preferred = frame[frame["分类标准"].astype(str).str.contains("申银万国", na=False)]
        if not preferred.empty:
            frame = preferred

    latest = frame.iloc[-1]
    for column in ["行业大类", "行业中类", "行业次类", "行业门类"]:
        value = latest.get(column)
        if isinstance(value, str) and value.strip() and value.strip().lower() != "nan":
            return value.strip()

    return "未分类"


def build_risk_tags(current: pd.Series, previous: pd.Series, strict: bool) -> list[str]:
    tags: list[str] = []
    broke_ma5 = previous["close"] >= previous["ma5"] and current["close"] < current["ma5"]
    below_ma10 = current["close"] < current["ma10"]
    heavy_drop = current["close"] < previous["close"] * 0.985 and current["volume_ratio"] >= 1.25
    high_death_cross = previous["k"] >= previous["d"] and current["k"] < current["d"] and max(previous["k"], previous["d"]) >= 75

    if broke_ma5:
        tags.append("跌破5日线")
    if below_ma10:
        tags.append("低于10日线")
    if heavy_drop:
        tags.append("放量下跌")
    if high_death_cross:
        tags.append("KDJ高位死叉")

    if not strict:
        if current["close"] < current["ma20"]:
            tags.append("仍在20日线下")
        if current["volume_ratio"] >= 1.8:
            tags.append("量能波动放大")
        if not tags:
            tags.append("信号待确认")

    return list(dict.fromkeys(tags))


def score_low_rebound(current: pd.Series, previous: pd.Series, change5d: float, change20d: float) -> float:
    return score_upside_priority("low-rebound", current, previous, change5d, change20d)


def score_trend_strength(current: pd.Series, previous: pd.Series, change5d: float, change20d: float) -> float:
    return score_upside_priority("trend-strength", current, previous, change5d, change20d)


def score_oversold_repair(current: pd.Series, previous: pd.Series, change5d: float, change20d: float) -> float:
    return score_upside_priority("oversold-repair", current, previous, change5d, change20d)


def score_upside_priority(signal_id: str, current: pd.Series, previous: pd.Series, change5d: float, change20d: float) -> float:
    base = {
        "trend-strength": 62,
        "low-rebound": 46,
        "oversold-repair": 44,
    }[signal_id]

    trend_confirmation = 0.0
    if current["close"] >= current["ma5"]:
        trend_confirmation += 8
    if current["close"] >= current["ma10"]:
        trend_confirmation += 8
    if current["close"] >= current["ma20"]:
        trend_confirmation += 6
    if current["ma5"] >= current["ma10"]:
        trend_confirmation += 5
    if current["dif"] > current["dea"]:
        trend_confirmation += 8
    if current["histogram"] > previous["histogram"]:
        trend_confirmation += 6
    if current["k"] > current["d"]:
        trend_confirmation += 4

    volume_confirmation = min(12, max(0, current["volume_ratio"] - 1) * 7)
    recent_confirmation = clamp(change5d, -8, 12) * 1.2 + clamp(change20d, -15, 18) * 0.35

    signal_quality = 0.0
    if signal_id == "trend-strength":
        signal_quality += max(0, current["dif"] - current["dea"]) * 140
        signal_quality += ((current["close"] - max(current["ma5"], current["ma10"])) / current["close"]) * 120
    elif signal_id == "low-rebound":
        signal_quality += max(0, 30 - min(current["k"], current["d"])) * 0.45
        signal_quality += max(0, current["k"] - current["d"]) * 0.8
    else:
        signal_quality += (current["rsi"] - previous["rsi"]) * 1.2
        signal_quality += ((current["close"] - current["boll_lower"]) / current["close"]) * 70
        signal_quality += max(0, 45 - current["rsi"]) * 0.25

    risk_penalty = 0.0
    if current["close"] < current["ma10"]:
        risk_penalty += 12
    if current["close"] < current["ma20"]:
        risk_penalty += 18
    if current["close"] < previous["close"] * 0.985 and current["volume_ratio"] >= 1.25:
        risk_penalty += 12
    if previous["k"] >= previous["d"] and current["k"] < current["d"]:
        risk_penalty += 10
    if change5d < -5:
        risk_penalty += 6
    if current["rsi"] > 78:
        risk_penalty += 6

    return base + trend_confirmation + volume_confirmation + recent_confirmation + signal_quality - risk_penalty


def score_risk(current: pd.Series, previous: pd.Series) -> float:
    tags = build_risk_tags(current, previous, strict=True)
    drop = max(0, (previous["close"] - current["close"]) / previous["close"]) * 220
    volume_penalty = max(0, current["volume_ratio"] - 1) * 16
    high_kdj_bonus = max(0, max(previous["k"], previous["d"]) - 70) * 0.8
    return 48 + len(tags) * 8 + drop + volume_penalty + high_kdj_bonus


def assemble_snapshot(rows: list[dict[str, Any]], per_board: int, source_label: str, meta: dict[str, Any]) -> dict[str, Any]:
    rows = sorted(rows, key=row_sort_key)
    boards: list[dict[str, Any]] = []

    for definition in SIGNAL_DEFINITIONS:
        board_rows = [row for row in rows if row["signalId"] == definition["id"]][:per_board]
        boards.append({**definition, "rows": board_rows})

    top_rows = [row for board in boards for row in board["rows"] if row["signalId"] in OBSERVATION_SIGNAL_IDS]
    top_rows = sorted(top_rows, key=row_sort_key)
    market_date = max((row["triggerDate"] for row in top_rows), default=datetime.now(CHINA_TZ).strftime("%Y-%m-%d"))

    return {
        "marketDate": market_date,
        "refreshedAt": datetime.now(CHINA_TZ).isoformat(),
        "source": "provider",
        "sourceLabel": source_label,
        "meta": meta,
        "boards": boards,
        "topRows": top_rows,
        "philosophy": PHILOSOPHY,
        "disclaimers": DISCLAIMERS,
    }


def row_sort_key(row: dict[str, Any]) -> tuple[int, str]:
    return (-int(row["signalStrength"]), str(row["code"]))


def calculate_return(frame: pd.DataFrame, lookback: int) -> float:
    if len(frame) <= lookback:
        return 0.0
    previous = frame.iloc[-1 - lookback]["close"]
    current = frame.iloc[-1]["close"]
    return ((current - previous) / previous) * 100


def rounded(value: Any, digits: int = 2) -> float:
    if pd.isna(value):
        return 0.0
    return round(float(value), digits)


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def market_symbol(code: str) -> str:
    if code.startswith(("6", "9")):
        return f"sh{code}"
    if code.startswith(("4", "8")):
        return f"bj{code}"
    return f"sz{code}"


def call_with_retry(func: Any, label: str, attempts: int = 3, delay: float = 1.5) -> Any:
    last_error: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            return func()
        except Exception as exc:  # pragma: no cover - provider/network variability
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(delay * attempt)

    raise RuntimeError(f"{label} failed after {attempts} attempts: {last_error}")


if __name__ == "__main__":
    main()
