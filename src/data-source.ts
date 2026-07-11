import bundledSnapshot from "../data/latest.json";
import { buildSnapshotFromStocks, enforceSnapshotLiquidity } from "./signals";
import type { CompanyProfile, SignalSnapshot, StockSeries } from "./types";

export interface Env {
  SIGNAL_KV?: KVNamespace;
  DATA_PROVIDER_URL?: string;
  DATA_PROVIDER_AUTH?: string;
  REFRESH_TOKEN?: string;
  BUNDLED_HISTORY_FALLBACK?: string;
}

const CACHE_KEY = "latest-signal-snapshot";
export const LATEST_SIGNAL_SNAPSHOT_KEY = CACHE_KEY;
export const STAGING_SIGNAL_SNAPSHOT_KEY = "staging-signal-snapshot";
export const DATED_SIGNAL_SNAPSHOT_PREFIX = "signal-snapshot:";
export const COMPANY_PROFILE_PREFIX = "company-profile:";
export const COMPANY_PROFILE_CHUNK_PREFIX = "company-profiles:";

export async function getCompanyProfile(env: Env, code: string): Promise<CompanyProfile | null> {
  if (!env.SIGNAL_KV || !/^\d{6}$/.test(code)) {
    return null;
  }

  try {
    const chunk = await env.SIGNAL_KV.get<Record<string, CompanyProfile>>(
      `${COMPANY_PROFILE_CHUNK_PREFIX}${code.slice(0, 2)}`,
      "json"
    );
    if (chunk) {
      const profile = chunk[code];
      return profile && profile.code === code ? profile : null;
    }

    // Compatibility with the original one-key-per-company migration.
    const legacy = await env.SIGNAL_KV.get<CompanyProfile>(`${COMPANY_PROFILE_PREFIX}${code}`, "json");
    return legacy && legacy.code === code ? legacy : null;
  } catch {
    return null;
  }
}

export async function getSnapshot(env: Env, now = new Date()): Promise<SignalSnapshot> {
  const cached = await readPublishedSnapshot(env);
  const bundled = getBundledSnapshot();
  if (cached) {
    const normalized = enforceSnapshotLiquidity(cached);
    if (bundled.marketDate > cached.marketDate) {
      return bundled;
    }
    if (hasLegacyObservationRows(cached) && bundled.marketDate >= cached.marketDate) {
      return bundled;
    }
    return normalized;
  }

  if (env.DATA_PROVIDER_URL) {
    return await refreshSnapshot(env, now);
  }

  return bundled;
}

/** Builds a provider preview only. Production persistence is handled by the
 * history-aware Actions publisher so latest/history can never diverge. */
export async function refreshSnapshot(env: Env, now = new Date()): Promise<SignalSnapshot> {
  let snapshot: SignalSnapshot;

  if (env.DATA_PROVIDER_URL) {
    const stocks = await fetchProviderStocks(env);
    snapshot = buildSnapshotFromStocks(stocks, now, "外部行情数据源");
  } else {
    snapshot = getBundledSnapshot();
  }

  return snapshot;
}

function getBundledSnapshot(): SignalSnapshot {
  return enforceSnapshotLiquidity(bundledSnapshot as SignalSnapshot);
}

async function readPublishedSnapshot(env: Env): Promise<SignalSnapshot | null> {
  if (!env.SIGNAL_KV) {
    return null;
  }

  let latest: SignalSnapshot | null = null;
  try {
    latest = await env.SIGNAL_KV.get<SignalSnapshot>(CACHE_KEY, "json");
  } catch {
    // The latest key keeps its existing best-effort fallback behavior.
  }

  try {
    const rawIndex = await env.SIGNAL_KV.get<unknown>("signal-history-index", "json");
    const indexedEntry = findNewestReadyHistoryEntry(rawIndex);
    if (!indexedEntry) {
      return latest;
    }

    const key = indexedEntry.snapshotKey || `history-snapshot:${indexedEntry.date}`;
    const indexed = await env.SIGNAL_KV.get<SignalSnapshot>(key, "json");
    if (!isSnapshotForDate(indexed, indexedEntry.date)) {
      return latest;
    }

    // The history index is the publication commit point. It wins on equal
    // dates (including forced revisions), while a newer legacy latest payload
    // remains usable during the one-time history bootstrap.
    if (!latest || indexed.marketDate >= latest.marketDate) {
      return indexed;
    }
  } catch {
    // Today's page remains best-effort; strict history routes never swallow KV errors.
  }

  return latest;
}

interface ReadyHistoryPointer {
  date: string;
  snapshotKey?: string;
}

function findNewestReadyHistoryEntry(value: unknown): ReadyHistoryPointer | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }

  const entries = value.entries
    .filter((entry): entry is Record<string, unknown> => (
      isRecord(entry) &&
      entry.status === "ready" &&
      typeof entry.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
      (entry.snapshotKey === undefined || (
        typeof entry.snapshotKey === "string" &&
        isSafeIndexedSnapshotKey(entry.snapshotKey, entry.date)
      ))
    ))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)));
  const newest = entries[0];
  if (!newest) {
    return null;
  }

  return {
    date: String(newest.date),
    ...(typeof newest.snapshotKey === "string" ? { snapshotKey: newest.snapshotKey } : {})
  };
}

function isSnapshotForDate(value: SignalSnapshot | null, date: string): value is SignalSnapshot {
  return Boolean(
    value &&
    value.marketDate === date &&
    Array.isArray(value.boards) &&
    Array.isArray(value.topRows)
  );
}

function isSafeIndexedSnapshotKey(key: string, date: string): boolean {
  return key === `history-snapshot:${date}` ||
    new RegExp(`^history-snapshot:${date}:v:[0-9a-f]{16}$`).test(key);
}

function hasLegacyObservationRows(snapshot: SignalSnapshot): boolean {
  return snapshot.boards.some((board) => board.id !== "risk-filter" && board.rows.some((row) => (
    typeof row.triggerClose !== "number" ||
    typeof row.liquidityEligible !== "boolean" ||
    !Array.isArray(row.liquidityTags) ||
    !("turnoverRate" in row) ||
    !("floatMarketCap" in row)
  )));
}

async function fetchProviderStocks(env: Env): Promise<StockSeries[]> {
  if (!env.DATA_PROVIDER_URL) {
    return [];
  }

  const headers = new Headers({ Accept: "application/json" });
  if (env.DATA_PROVIDER_AUTH) {
    headers.set("Authorization", `Bearer ${env.DATA_PROVIDER_AUTH}`);
  }

  const response = await fetch(env.DATA_PROVIDER_URL, { headers });
  if (!response.ok) {
    throw new Error(`provider responded ${response.status}`);
  }

  const payload = await response.json<unknown>();
  return parseProviderPayload(payload);
}

function parseProviderPayload(payload: unknown): StockSeries[] {
  const stocks = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.stocks)
      ? payload.stocks
      : null;

  if (!stocks) {
    throw new Error("provider payload must be an array or { stocks: [...] }");
  }

  return stocks.map((item, index) => {
    if (!isRecord(item) || typeof item.code !== "string" || typeof item.name !== "string" || typeof item.industry !== "string" || !Array.isArray(item.bars)) {
      throw new Error(`invalid stock item at index ${index}`);
    }

    return {
      code: item.code,
      name: item.name,
      industry: item.industry,
      bars: item.bars.map((bar, barIndex) => {
        if (
          !isRecord(bar) ||
          typeof bar.date !== "string" ||
          !isNumber(bar.open) ||
          !isNumber(bar.high) ||
          !isNumber(bar.low) ||
          !isNumber(bar.close) ||
          !isNumber(bar.volume) ||
          !isNumber(bar.amount) ||
          !isOptionalNumber(bar.turnoverRate) ||
          !isOptionalNumber(bar.floatMarketCap)
        ) {
          throw new Error(`invalid bar at ${item.code}[${barIndex}]`);
        }

        return {
          date: bar.date,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          amount: bar.amount,
          turnoverRate: bar.turnoverRate ?? null,
          floatMarketCap: bar.floatMarketCap ?? null
        };
      })
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isNumber(value);
}
