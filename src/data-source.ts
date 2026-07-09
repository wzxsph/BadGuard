import bundledSnapshot from "../data/latest.json";
import { buildSnapshotFromStocks } from "./signals";
import type { SignalSnapshot, StockSeries } from "./types";

export interface Env {
  SIGNAL_KV?: KVNamespace;
  DATA_PROVIDER_URL?: string;
  DATA_PROVIDER_AUTH?: string;
  REFRESH_TOKEN?: string;
}

const CACHE_KEY = "latest-signal-snapshot";
export const LATEST_SIGNAL_SNAPSHOT_KEY = CACHE_KEY;
export const STAGING_SIGNAL_SNAPSHOT_KEY = "staging-signal-snapshot";
export const DATED_SIGNAL_SNAPSHOT_PREFIX = "signal-snapshot:";

export async function getSnapshot(env: Env, now = new Date()): Promise<SignalSnapshot> {
  const cached = await readCachedSnapshot(env);
  if (cached) {
    return cached;
  }

  if (env.DATA_PROVIDER_URL) {
    return await refreshSnapshot(env, now, false);
  }

  return getBundledSnapshot();
}

export async function refreshSnapshot(env: Env, now = new Date(), persist = true): Promise<SignalSnapshot> {
  let snapshot: SignalSnapshot;

  if (env.DATA_PROVIDER_URL) {
    const stocks = await fetchProviderStocks(env);
    snapshot = buildSnapshotFromStocks(stocks, now, "外部行情数据源");
  } else {
    snapshot = getBundledSnapshot();
  }

  if (persist && env.SIGNAL_KV) {
    await env.SIGNAL_KV.put(CACHE_KEY, JSON.stringify(snapshot), {
      expirationTtl: 60 * 60 * 36
    });
  }

  return snapshot;
}

function getBundledSnapshot(): SignalSnapshot {
  return bundledSnapshot as SignalSnapshot;
}

async function readCachedSnapshot(env: Env): Promise<SignalSnapshot | null> {
  if (!env.SIGNAL_KV) {
    return null;
  }

  try {
    return await env.SIGNAL_KV.get<SignalSnapshot>(CACHE_KEY, "json");
  } catch {
    return null;
  }
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
          !isNumber(bar.amount)
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
          amount: bar.amount
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
