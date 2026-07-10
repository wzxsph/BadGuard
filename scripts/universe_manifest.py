"""Versioned sticky A-share universe reconciliation."""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any

try:
    from scripts.build_akshare_snapshot import StockItem
except ModuleNotFoundError:  # Direct `python scripts/...py` execution.
    from build_akshare_snapshot import StockItem  # type: ignore[no-redef]


UNIVERSE_MANIFEST_VERSION = 1
DEFAULT_MAX_UNIVERSE_DELTA_RATE = 0.01


def reconcile_universe_manifest(
    candidate_stocks: list[StockItem],
    source: str,
    generated_at: datetime,
    prior_manifest: dict[str, Any] | None = None,
    maximum_delta_rate: float = DEFAULT_MAX_UNIVERSE_DELTA_RATE,
) -> dict[str, Any]:
    if not 0 <= maximum_delta_rate <= 1:
        raise ValueError("maximum universe delta rate must be between 0 and 1.")
    candidates = normalize_candidate_stocks(candidate_stocks)
    candidate_by_code = {stock.code: stock for stock in candidates}
    timestamp = generated_at.isoformat()

    if prior_manifest is None:
        members = [
            {
                "code": stock.code,
                "name": stock.name,
                "industry": stock.industry,
                "status": "active",
                "firstSeenAt": timestamp,
            }
            for stock in candidates
        ]
        payload = build_manifest_payload(
            source=source,
            generated_at=timestamp,
            previous_revision=None,
            members=members,
            delta={
                "bootstrap": True,
                "candidateCount": len(candidates),
                "addedCodes": [],
                "newlyMissingCodes": [],
                "stillStaleCodes": [],
                "reactivatedCodes": [],
                "renamedCodes": [],
                "addedRate": 0.0,
                "missingRate": 0.0,
                "memberDenominator": len(candidates),
                "activeDenominator": len(candidates),
                "maximumDeltaRate": maximum_delta_rate,
            },
        )
        return with_universe_revision(payload)

    prior = validate_universe_manifest(prior_manifest)
    prior_by_code = {member["code"]: member for member in prior["members"]}
    prior_codes = set(prior_by_code)
    candidate_codes = set(candidate_by_code)
    added_codes = sorted(candidate_codes - prior_codes)
    newly_missing_codes = sorted(
        code
        for code, member in prior_by_code.items()
        if member["status"] == "active" and code not in candidate_codes
    )
    still_stale_codes = sorted(
        code
        for code, member in prior_by_code.items()
        if member["status"] == "stale" and code not in candidate_codes
    )
    reactivated_codes = sorted(
        code
        for code, member in prior_by_code.items()
        if member["status"] == "stale" and code in candidate_codes
    )
    active_denominator = max(1, sum(member["status"] == "active" for member in prior["members"]))
    member_denominator = max(1, len(prior["members"]))
    added_rate = len(added_codes) / member_denominator
    missing_rate = len(newly_missing_codes) / active_denominator
    if added_rate > maximum_delta_rate + 1e-12 or missing_rate > maximum_delta_rate + 1e-12:
        raise ValueError(
            "Universe candidate delta exceeds the accepted threshold: "
            f"added={len(added_codes)}/{member_denominator} ({added_rate:.2%}), "
            f"newly-missing={len(newly_missing_codes)}/{active_denominator} ({missing_rate:.2%}), "
            f"maximum={maximum_delta_rate:.2%}."
        )

    renamed_codes: list[str] = []
    members: list[dict[str, Any]] = []
    for code in sorted(prior_codes | candidate_codes):
        candidate = candidate_by_code.get(code)
        previous = prior_by_code.get(code)
        if candidate is not None:
            if previous is not None and previous["name"] != candidate.name:
                renamed_codes.append(code)
            members.append({
                "code": code,
                "name": candidate.name,
                "industry": candidate.industry if candidate.industry != "未分类" else previous.get("industry", "未分类") if previous else "未分类",
                "status": "active",
                "firstSeenAt": previous["firstSeenAt"] if previous else timestamp,
            })
        else:
            if previous is None:  # pragma: no cover - union invariant
                raise AssertionError(code)
            members.append({
                "code": code,
                "name": previous["name"],
                "industry": previous["industry"],
                "status": "stale",
                "firstSeenAt": previous["firstSeenAt"],
                "staleSinceAt": previous.get("staleSinceAt", timestamp),
            })

    delta = {
        "bootstrap": False,
        "candidateCount": len(candidates),
        "addedCodes": added_codes,
        "newlyMissingCodes": newly_missing_codes,
        "stillStaleCodes": still_stale_codes,
        "reactivatedCodes": reactivated_codes,
        "renamedCodes": sorted(renamed_codes),
        "addedRate": round(added_rate, 8),
        "missingRate": round(missing_rate, 8),
        "memberDenominator": member_denominator,
        "activeDenominator": active_denominator,
        "maximumDeltaRate": maximum_delta_rate,
    }
    payload = build_manifest_payload(
        source=source,
        generated_at=timestamp,
        previous_revision=prior["revision"],
        members=members,
        delta=delta,
    )
    proposed = with_universe_revision(payload)
    # Reuse the exact accepted payload when the effective pool did not change.
    if proposed["revision"] == prior["revision"]:
        return prior
    return proposed


def build_manifest_payload(
    source: str,
    generated_at: str,
    previous_revision: str | None,
    members: list[dict[str, Any]],
    delta: dict[str, Any],
) -> dict[str, Any]:
    active_count = sum(member["status"] == "active" for member in members)
    stale_count = len(members) - active_count
    return {
        "version": UNIVERSE_MANIFEST_VERSION,
        "generatedAt": generated_at,
        "source": source,
        "previousRevision": previous_revision,
        "memberCount": len(members),
        "activeCount": active_count,
        "staleCount": stale_count,
        "members": members,
        "delta": delta,
    }


def calculate_universe_revision(manifest: dict[str, Any]) -> str:
    stable = {
        "version": manifest.get("version"),
        "source": manifest.get("source"),
        "members": manifest.get("members"),
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def with_universe_revision(payload: dict[str, Any]) -> dict[str, Any]:
    return {**payload, "revision": calculate_universe_revision(payload)}


def load_optional_universe_manifest(path: str | Path | None) -> dict[str, Any] | None:
    if not path:
        return None
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if raw is None:
        return None
    return validate_universe_manifest(raw)


def validate_universe_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("version") != UNIVERSE_MANIFEST_VERSION:
        raise ValueError(f"Universe manifest must be version {UNIVERSE_MANIFEST_VERSION}.")
    if manifest.get("revision") != calculate_universe_revision(manifest):
        raise ValueError("Universe manifest revision does not match its members.")
    members = manifest.get("members")
    if not isinstance(members, list) or not members:
        raise ValueError("Universe manifest members must be a non-empty list.")
    codes: list[str] = []
    active_count = 0
    for member in members:
        if not isinstance(member, dict):
            raise ValueError("Universe manifest contains a malformed member.")
        code = member.get("code")
        status = member.get("status")
        if (
            not isinstance(code, str)
            or len(code) != 6
            or not code.isdigit()
            or not isinstance(member.get("name"), str)
            or not member["name"].strip()
            or not isinstance(member.get("industry"), str)
            or status not in {"active", "stale"}
            or not isinstance(member.get("firstSeenAt"), str)
            or (status == "stale" and not isinstance(member.get("staleSinceAt"), str))
            or (status == "active" and "staleSinceAt" in member)
        ):
            raise ValueError(f"Universe manifest member is invalid: {member!r}.")
        codes.append(code)
        active_count += int(status == "active")
    if codes != sorted(codes) or len(codes) != len(set(codes)):
        raise ValueError("Universe manifest members must be unique and sorted by code.")
    if (
        manifest.get("memberCount") != len(members)
        or manifest.get("activeCount") != active_count
        or manifest.get("staleCount") != len(members) - active_count
    ):
        raise ValueError("Universe manifest member counts are inconsistent.")
    if (
        not isinstance(manifest.get("generatedAt"), str)
        or manifest.get("source") not in {"code-list", "realtime"}
    ):
        raise ValueError("Universe manifest metadata is invalid.")
    if not isinstance(manifest.get("delta"), dict):
        raise ValueError("Universe manifest delta is invalid.")
    return manifest


def normalize_candidate_stocks(stocks: list[StockItem]) -> list[StockItem]:
    by_code: dict[str, StockItem] = {}
    for stock in stocks:
        if len(stock.code) != 6 or not stock.code.isdigit() or not stock.name.strip():
            raise ValueError(f"Invalid universe candidate: {stock!r}.")
        by_code[stock.code] = stock
    if not by_code:
        raise ValueError("Universe candidate list is empty.")
    return [by_code[code] for code in sorted(by_code)]
