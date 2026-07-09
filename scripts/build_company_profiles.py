#!/usr/bin/env python3
"""Build or refresh the fixed company profile database used by the UI."""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


CHINA_TZ = ZoneInfo("Asia/Shanghai")
PROFILE_COLUMNS = {
    "公司名称": "companyName",
    "英文名称": "englishName",
    "曾用简称": "formerName",
    "A股简称": "name",
    "所属市场": "market",
    "所属行业": "industry",
    "法人代表": "legalRepresentative",
    "注册资金": "registeredCapital",
    "成立日期": "establishedDate",
    "上市日期": "listingDate",
    "官方网站": "website",
    "电子邮箱": "email",
    "联系电话": "phone",
    "注册地址": "registeredAddress",
    "办公地址": "officeAddress",
    "邮政编码": "postalCode",
    "主营业务": "mainBusiness",
    "经营范围": "businessScope",
    "机构简介": "organizationProfile",
}
REGION_PREFIXES = [
    "北京市",
    "天津市",
    "上海市",
    "重庆市",
    "河北省",
    "山西省",
    "辽宁省",
    "吉林省",
    "黑龙江省",
    "江苏省",
    "浙江省",
    "安徽省",
    "福建省",
    "江西省",
    "山东省",
    "河南省",
    "湖北省",
    "湖南省",
    "广东省",
    "海南省",
    "四川省",
    "贵州省",
    "云南省",
    "陕西省",
    "甘肃省",
    "青海省",
    "台湾省",
    "内蒙古自治区",
    "广西壮族自治区",
    "西藏自治区",
    "宁夏回族自治区",
    "新疆维吾尔自治区",
]


def main() -> None:
    args = parse_args()
    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    existing = load_existing(Path(args.output))
    rows = merge_existing_profile_rows(unique_signal_rows(snapshot), existing)
    if args.limit > 0:
        rows = rows[: args.limit]

    if args.fetch_akshare:
        try:
            import akshare as ak  # type: ignore
        except ImportError as exc:  # pragma: no cover - friendly CLI failure
            raise SystemExit("AkShare is not installed. Run: uv sync") from exc
    else:
        ak = None

    market_date = str(snapshot.get("marketDate") or "")
    updated_at = market_date or datetime.now(CHINA_TZ).strftime("%Y-%m-%d")
    profiles: dict[str, dict[str, Any]] = dict(existing)

    for index, row in enumerate(rows, start=1):
        code = str(row["code"]).zfill(6)
        profile = {**make_base_profile(row, updated_at), **profiles.get(code, {})}

        if ak is not None:
            fetched_profile = fetch_cninfo_profile(ak, code)
            business_segments = fetch_business_segments(ak, code)

            if fetched_profile:
                profile.update(fetched_profile)
            if business_segments:
                profile["businessComposition"] = business_segments

            if fetched_profile or business_segments:
                profile["profileSource"] = "akshare-f10"
                profile["updatedAt"] = updated_at
                profile["note"] = "F10 静态资料来自 AkShare 聚合的巨潮公司概况与东方财富主营构成；适合快速认识公司，不替代公告原文。"

            if args.sleep > 0:
                time.sleep(args.sleep)

        profiles[code] = normalize_profile(profile)
        if index % 25 == 0:
            print(f"Processed {index}/{len(rows)} company profiles.")

    ordered = {code: profiles[code] for code in sorted(profiles)}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(ordered)} company profiles to {args.output}.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh the fixed BadGuard company profile database.")
    parser.add_argument("--snapshot", default="data/latest.json", help="Signal snapshot JSON path.")
    parser.add_argument("--output", default="data/company-profiles.json", help="Company profile database JSON path.")
    parser.add_argument("--fetch-akshare", action="store_true", help="Fetch F10-like fields with AkShare.")
    parser.add_argument("--limit", type=int, default=0, help="Limit profiles for a quick smoke test; 0 means all signal stocks.")
    parser.add_argument("--sleep", type=float, default=0.15, help="Seconds to sleep between AkShare profile requests.")
    return parser.parse_args()


def load_existing(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def unique_signal_rows(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    for board in snapshot.get("boards", []):
        for row in board.get("rows", []):
            code = str(row.get("code", "")).zfill(6)
            if not code or code in seen:
                continue
            seen.add(code)
            rows.append(row)

    return rows


def merge_existing_profile_rows(rows: list[dict[str, Any]], existing: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    seen = {str(row.get("code", "")).zfill(6) for row in rows}
    merged = list(rows)

    for code in sorted(existing):
        normalized_code = str(code).zfill(6)
        if normalized_code in seen:
            continue

        profile = existing[code]
        merged.append(
            {
                "code": normalized_code,
                "name": profile.get("name") or profile.get("companyName") or normalized_code,
                "industry": profile.get("industry") or "未分类",
            }
        )
        seen.add(normalized_code)

    return merged


def make_base_profile(row: dict[str, Any], updated_at: str) -> dict[str, Any]:
    code = str(row["code"]).zfill(6)
    return {
        "code": code,
        "name": str(row.get("name") or code),
        "industry": str(row.get("industry") or "未分类"),
        "market": infer_market(code),
        "listingDate": "",
        "establishedDate": "",
        "region": "",
        "website": "",
        "mainBusiness": "",
        "businessScope": "",
        "organizationProfile": "",
        "businessComposition": [],
        "profileSource": "signal-snapshot",
        "updatedAt": updated_at,
        "note": "暂未抓到完整 F10，只保留信号快照里的基础识别信息；别急，这家公司资料还在路上。",
    }


def fetch_cninfo_profile(ak: Any, code: str) -> dict[str, Any]:
    try:
        frame = ak.stock_profile_cninfo(symbol=code)
    except Exception as exc:  # pragma: no cover - provider variability
        print(f"Skipped CNInfo profile for {code}: {exc}")
        return {}

    if frame is None or frame.empty:
        return {}

    row = frame.iloc[0]
    profile: dict[str, Any] = {}
    for source_key, target_key in PROFILE_COLUMNS.items():
        value = clean_value(row.get(source_key))
        if value:
            profile[target_key] = value

    region = infer_region(profile.get("registeredAddress", ""), profile.get("officeAddress", ""))
    if region:
        profile["region"] = region

    return profile


def fetch_business_segments(ak: Any, code: str) -> list[dict[str, Any]]:
    try:
        frame = ak.stock_zygc_em(symbol=market_symbol(code))
    except Exception as exc:  # pragma: no cover - provider variability
        print(f"Skipped business segments for {code}: {exc}")
        return []

    if frame is None or frame.empty:
        return []

    frame = frame.copy()
    frame["报告日期"] = frame["报告日期"].astype(str)
    latest_report_date = sorted(frame["报告日期"].dropna().unique())[-1]
    latest = frame[frame["报告日期"] == latest_report_date].copy()

    for category in ["按产品分类", "按行业分类"]:
        selected = latest[latest["分类类型"] == category].copy()
        if not selected.empty:
            break
    else:
        selected = latest.copy()

    selected["收入比例"] = selected["收入比例"].apply(float_or_none)
    selected = selected[selected["收入比例"].notna()]
    selected = selected.sort_values("收入比例", ascending=False)

    segments: list[dict[str, Any]] = []
    for _, row in selected.iterrows():
        name = clean_value(row.get("主营构成"))
        if not name or "合计" in name or name in {"其他", "其他业务"} or name.startswith(("其他(", "其他（")):
            continue

        gross_margin = float_or_none(row.get("毛利率"))
        segment = {
            "category": clean_value(row.get("分类类型")),
            "name": name,
            "reportDate": clean_value(row.get("报告日期")),
            "revenueRatioPct": round_float(float(row["收入比例"]) * 100, 1),
        }
        if gross_margin is not None:
            segment["grossMarginPct"] = round_float(gross_margin * 100, 1)

        segments.append(segment)

        if len(segments) >= 4:
            break

    return segments


def normalize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in profile.items():
        if isinstance(value, list):
            normalized[key] = [normalize_profile(item) if isinstance(item, dict) else item for item in value]
        elif isinstance(value, dict):
            normalized[key] = normalize_profile(value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            normalized[key] = value if math.isfinite(float(value)) else ""
        else:
            cleaned = clean_value(value)
            normalized[key] = cleaned
    return normalized


def clean_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"nan", "none", "null"} else text


def float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def round_float(value: float | None, digits: int) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def infer_region(*values: str) -> str:
    text = " ".join(value for value in values if value)
    for region in REGION_PREFIXES:
        if region in text:
            return region
    return ""


def infer_market(code: str) -> str:
    if code.startswith("6"):
        return "上交所"
    if code.startswith(("8", "4")):
        return "北交所"
    return "深交所"


def market_symbol(code: str) -> str:
    if code.startswith("6"):
        return f"SH{code}"
    if code.startswith(("8", "4")):
        return f"BJ{code}"
    return f"SZ{code}"


if __name__ == "__main__":
    main()
