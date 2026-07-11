import { getHistoryIndex } from "./history";
import type { Env } from "./data-source";
import type { SignalSnapshot } from "./types";

export interface DataFreshness {
  ok: boolean;
  status: "fresh" | "stale" | "unknown";
  expectedMarketDate: string | null;
  currentMarketDate: string;
  historyReady: boolean;
  missingDates: string[];
  checkedAt: string;
  label: string;
}

export async function getDataFreshness(
  env: Env,
  snapshot: SignalSnapshot,
  now = new Date(),
  closeGraceMinutes = 45
): Promise<DataFreshness> {
  const index = await getHistoryIndex(env);
  const expectedMarketDate = expectedCompletedTradingDate(index.tradingDates, now, closeGraceMinutes);
  const readyDates = new Set(index.entries.filter((entry) => entry.status === "ready").map((entry) => entry.date));
  const completedDates = expectedMarketDate
    ? index.tradingDates.filter((date) => date <= expectedMarketDate).slice(-5)
    : [];
  const missingDates = completedDates.filter((date) => !readyDates.has(date));
  const historyReady = expectedMarketDate !== null && readyDates.has(expectedMarketDate);
  const ok = expectedMarketDate !== null && snapshot.marketDate === expectedMarketDate && historyReady && missingDates.length === 0;

  return {
    ok,
    status: expectedMarketDate === null ? "unknown" : ok ? "fresh" : "stale",
    expectedMarketDate,
    currentMarketDate: snapshot.marketDate,
    historyReady,
    missingDates,
    checkedAt: now.toISOString(),
    label: expectedMarketDate === null
      ? "交易日状态暂不可用"
      : ok
        ? `已更新至 ${expectedMarketDate}`
        : `正在补齐 ${expectedMarketDate}，当前展示 ${snapshot.marketDate}`
  };
}

export function expectedCompletedTradingDate(
  tradingDates: string[],
  now = new Date(),
  closeGraceMinutes = 45
): string | null {
  const local = chinaParts(now);
  const localDate = `${local.year}-${local.month}-${local.day}`;
  const todayIsTrading = tradingDates.includes(localDate);
  const afterGrace = local.hour * 60 + local.minute >= 15 * 60 + closeGraceMinutes;
  const cutoff = todayIsTrading && !afterGrace
    ? tradingDates.filter((date) => date < localDate).at(-1)
    : tradingDates.filter((date) => date <= localDate).at(-1);
  return cutoff ?? null;
}

function chinaParts(value: Date): {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}
