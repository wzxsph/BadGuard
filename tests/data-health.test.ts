import { describe, expect, it } from "vitest";
import latestSnapshot from "../data/latest.json";
import { expectedCompletedTradingDate, getDataFreshness } from "../src/data-health";
import type { SignalSnapshot } from "../src/types";

const tradingDates = ["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13"];

describe("data freshness", () => {
  it("waits for the post-close grace period and keeps Friday as Saturday's target", () => {
    expect(expectedCompletedTradingDate(tradingDates, new Date("2026-07-10T07:30:00Z"), 45)).toBe("2026-07-09");
    expect(expectedCompletedTradingDate(tradingDates, new Date("2026-07-10T08:00:00Z"), 45)).toBe("2026-07-10");
    expect(expectedCompletedTradingDate(tradingDates, new Date("2026-07-11T00:00:00Z"), 45)).toBe("2026-07-10");
  });

  it("reports the missing July 10 history entry even when the bundled homepage is current", async () => {
    const snapshot = latestSnapshot as SignalSnapshot;
    const index = {
      version: 1,
      tradingDates,
      entries: [
        { date: "2026-07-09", source: "backfill", status: "ready" },
        { date: "2026-07-08", source: "backfill", status: "ready" }
      ]
    };
    const freshness = await getDataFreshness({
      SIGNAL_KV: {
        get: async (key: string) => key === "signal-history-index" ? index : null
      } as unknown as KVNamespace
    }, snapshot, new Date("2026-07-11T00:00:00Z"));

    expect(freshness).toMatchObject({
      ok: false,
      status: "stale",
      expectedMarketDate: "2026-07-10",
      currentMarketDate: "2026-07-10",
      historyReady: false,
      missingDates: ["2026-07-10"]
    });
    expect(freshness.label).toContain("正在补齐 2026-07-10");
  });
});
