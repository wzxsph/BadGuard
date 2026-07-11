#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { assertSnapshotCompleteness } from "./history_index.mjs";

const args = parseArgs(process.argv.slice(2));
const output = args.output || "data/quality-audit.json";
const marketDateLookback = Number(args["market-lookback"] ?? 5);
const minHistoryCoverage = Number(args["min-history-coverage"] ?? 0.98);
const minCloseCoverage = Number(args["min-close-coverage"] ?? 0.98);
const closeGraceMinutes = Number(args["close-grace-minutes"] ?? 45);
const baseUrl = String(args["base-url"] ?? "").replace(/\/$/, "");

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
const namespaceId = requiredEnv("KV_NAMESPACE_ID");
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values`;
const headers = { Authorization: `Bearer ${apiToken}` };

const indexText = await get("signal-history-index");
if (!indexText) {
  const summary = {
    reason: "missing-signal-history-index",
    needsBackfill: true,
    backfill: null,
    dates: []
  };
  await writeSummary(output, summary);
  await setOutput(summary);
  process.exit(0);
}

const index = JSON.parse(indexText);
if (!Array.isArray(index.tradingDates) || !Array.isArray(index.entries)) {
  throw new Error("signal-history-index shape is invalid.");
}

const readyEntries = new Map(
  index.entries
    .filter((entry) => entry?.status === "ready" && typeof entry.date === "string")
    .map((entry) => [entry.date, entry])
);

const tradingDates = [...index.tradingDates].filter((value) => typeof value === "string").sort();
if (tradingDates.length === 0) {
  const summary = {
    reason: "history-calendar-empty",
    needsBackfill: false,
    backfill: null,
    dates: []
  };
  await writeSummary(output, summary);
  await setOutput(summary);
  process.exit(0);
}

const latestCompletedDate = latestCompletedTradingDate(tradingDates, new Date(), closeGraceMinutes);
if (!latestCompletedDate) {
  const summary = {
    reason: "no-completed-trading-date",
    needsBackfill: false,
    backfill: null,
    recentDates: [],
    evaluatedCount: 0,
    missingCount: 0,
    dates: [],
    latestCompletedDate: null,
    marketDateLookback,
    thresholds: {
      minHistoryCoverage,
      minCloseCoverage
    },
    notes: ["No completed trading date available to compare against; skipping backfill check."]
  };
  await writeSummary(output, summary);
  await setOutput(summary);
  process.exit(0);
}

const recentDates = tradingDates
  .filter((date) => date <= latestCompletedDate)
  .slice(-Math.max(1, marketDateLookback));

const evaluated = [];
for (const date of recentDates) {
  const dateResult = await evaluateDate(date, readyEntries.get(date), headers, base, {
    minHistoryCoverage,
    minCloseCoverage
  });
  evaluated.push(dateResult);
}

const missingDates = evaluated.filter((entry) => entry.needsBackfill);
const apiStatus = baseUrl && latestCompletedDate
  ? await evaluatePublicApi(baseUrl, latestCompletedDate)
  : null;
if (apiStatus?.needsBackfill && !missingDates.some((entry) => entry.date === latestCompletedDate)) {
  missingDates.push({
    date: latestCompletedDate,
    status: "api-stale",
    needsBackfill: true,
    reason: apiStatus.reason
  });
}
const needsBackfill = missingDates.length > 0;
const summary = {
  generatedAt: new Date().toISOString(),
  marketDateLookback,
  thresholds: {
    minHistoryCoverage,
    minCloseCoverage
  },
  latestCompletedDate,
  closeGraceMinutes,
  apiStatus,
  recentDates,
  evaluatedCount: evaluated.length,
  needsBackfill,
  missingCount: missingDates.length,
  missingDates,
  backfill: null,
  notes: []
};

if (needsBackfill && latestCompletedDate) {
  const earliestMissing = missingDates
    .map((item) => item.date)
    .sort()
    .at(0);
  const includeLiveTarget = missingDates.some((entry) => entry.date === latestCompletedDate);
  summary.backfill = {
    start: earliestMissing,
    end: latestCompletedDate,
    includeLiveTarget,
    reason: `Detected ${missingDates.length} date(s) in the recent window with missing or degraded quality`
  };
  summary.notes.push(`Queueing quality repair from ${summary.backfill.start} through ${summary.backfill.end}.`);
} else if (needsBackfill) {
  summary.notes.push("Missing historical quality detected, but no completed trading date exists to anchor backfill.");
}

await writeSummary(output, summary);
await setOutput(summary);

async function evaluateDate(date, entry, headersArg, keyBase, options) {
  if (!entry) {
    return {
      date,
      status: "missing",
      needsBackfill: true,
      reason: "No ready history entry for this trading date."
    };
  }

  const snapshotKey = entry.snapshotKey
    ? entry.snapshotKey
    : `history-snapshot:${date}`;
  const closeKey = entry.closeKey
    ? entry.closeKey
    : `market-close:${date}`;
  let source;
  let buildMode = "local";
  let stockCount;
  let historySuccessRate;
  let exactCloseCoverage;
  let providerMissingCount;
  let notListedCount;
  let suspendedCount;
  let closeTable;
  try {
    const snapshotText = await get(snapshotKey, headersArg, keyBase);
    if (!snapshotText) {
      return {
        date,
        status: "missing",
        needsBackfill: true,
        reason: `Snapshot payload missing for key ${snapshotKey}.`
      };
    }

    const closeText = await get(closeKey, headersArg, keyBase);
    if (!closeText) {
      return {
        date,
        status: "missing",
        needsBackfill: true,
        reason: `Close-table payload missing for key ${closeKey}.`
      };
    }

    const snapshot = JSON.parse(snapshotText);
    closeTable = JSON.parse(closeText);
    stockCount = Number(snapshot?.meta?.stockCount);
    historySuccessRate = Number(snapshot?.meta?.historySuccessRate);
    exactCloseCoverage = Number(snapshot?.meta?.exactCloseCoverage);
    providerMissingCount = Number(snapshot?.meta?.providerMissingCount ?? 0);
    notListedCount = Number(snapshot?.meta?.notListedCount ?? 0);
    suspendedCount = Number(snapshot?.meta?.suspendedCount ?? 0);
    source = snapshot?.source;
    buildMode = snapshot?.meta?.buildMode ?? "local";

    const qualityResult = assertSnapshotCompleteness(
      snapshot,
      closeTable,
      options.minHistoryCoverage,
      options.minCloseCoverage
    );

    return {
      date,
      status: "healthy",
      needsBackfill: false,
      reason: "ok",
      source,
      buildMode,
      stockCount: qualityResult.stockCount,
      historySuccessRate: Number(snapshot?.meta?.historySuccessRate),
      exactCloseCoverage: Number(snapshot?.meta?.exactCloseCoverage),
      providerMissingCount,
      notListedCount,
      suspendedCount,
      closeCount: qualityResult.exactCloseCount
    };
  } catch (error) {
    return {
      date,
      status: "error",
      needsBackfill: true,
      reason: `Failed to read quality payload: ${String(error.message || error)}`,
      source,
      buildMode,
      stockCount,
      historySuccessRate,
      exactCloseCoverage,
      providerMissingCount,
      notListedCount,
      suspendedCount,
      closeCount: Object.keys(closeTable?.closes || {}).length
    };
  }
}

async function get(key, customHeaders = headers, keyBase = base) {
  const response = await fetch(`${keyBase}/${encodeURIComponent(key)}`, {
    headers: customHeaders
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`KV GET ${key} failed: ${response.status} ${await response.text()}`);
  }
  return await response.text();
}

async function writeSummary(filePath, summary) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

function setOutput(summary) {
  if (!process.env.GITHUB_OUTPUT) return;
  const output = process.env.GITHUB_OUTPUT;
  const lines = [
    `NEEDS_BACKFILL=${String(Boolean(summary.needsBackfill))}`,
    `BACKFILL_START=${summary.backfill?.start ?? ""}`,
    `BACKFILL_END=${summary.backfill?.end ?? ""}`,
    `INCLUDE_LIVE_TARGET=${String(Boolean(summary.backfill?.includeLiveTarget))}`,
    `EVAL_COUNT=${Number.isFinite(summary.evaluatedCount) ? summary.evaluatedCount : 0}`,
    `MISSING_COUNT=${Number.isFinite(summary.missingCount) ? summary.missingCount : 0}`
  ];
  return fs.appendFile(output, `${lines.join("\n")}\n`, "utf8");
}

async function evaluatePublicApi(baseUrl, latestCompletedDate) {
  let lastReason = "public API did not respond";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [signalsResponse, historyResponse] = await Promise.all([
        fetch(`${baseUrl}/api/signals`),
        fetch(`${baseUrl}/api/history`)
      ]);
      if (!signalsResponse.ok || !historyResponse.ok) {
        lastReason = `public API status ${signalsResponse.status}/${historyResponse.status}`;
      } else {
        const signals = await signalsResponse.json();
        const history = await historyResponse.json();
        const entry = Array.isArray(history?.dates)
          ? history.dates.find((item) => item?.date === latestCompletedDate)
          : null;
        const healthy = signals?.marketDate === latestCompletedDate && entry?.status === "ready";
        return {
          healthy,
          needsBackfill: !healthy,
          latestCompletedDate,
          signalDate: signals?.marketDate ?? null,
          historyReady: entry?.status === "ready",
          reason: healthy
            ? "ok"
            : `public API is stale: signals=${signals?.marketDate ?? "missing"}, history=${entry?.status ?? "missing"}`
        };
      }
    } catch (error) {
      lastReason = String(error?.message || error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  return {
    healthy: false,
    needsBackfill: true,
    latestCompletedDate,
    signalDate: null,
    historyReady: false,
    reason: lastReason
  };
}

function latestCompletedTradingDate(tradingDates, now = new Date(), graceMinutes = 45) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(now);
  const byType = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const localDate = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
  const localHour = Number(byType.get("hour"));
  const localMinute = Number(byType.get("minute"));
  const afterCloseWithGrace = localHour * 60 + localMinute >= 15 * 60 + graceMinutes;
  const completedThrough = !afterCloseWithGrace
    ? previousTradingDate(tradingDates, localDate)
    : latestLessThanOrEqual(tradingDates, localDate);
  return completedThrough ?? latestLessThanOrEqual(tradingDates, localDate);
}

function latestLessThanOrEqual(values, target) {
  return values.filter((value) => value <= target).slice(-1)[0] ?? null;
}

function previousTradingDate(values, value) {
  return values.filter((candidate) => candidate < value).slice(-1)[0] ?? null;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArgs(raw) {
  const parsed = {};
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    if (!current.startsWith("--")) {
      throw new Error(`Unexpected argument: ${current}`);
    }
    const key = current.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
