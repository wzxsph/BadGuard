import { describe, expect, it } from "vitest";
import {
  ABNORMAL_TURNOVER_RATE,
  MIN_DAILY_AMOUNT,
  MIN_FLOAT_MARKET_CAP,
  assembleSnapshot,
  buildSnapshotFromStocks,
  compareRows,
  enforceSnapshotLiquidity,
  evaluateLiquidity
} from "../src/signals";
import { renderHtml } from "../src/render";
import type { DailyBar, SignalId, SignalRow, SignalSnapshot } from "../src/types";

describe("liquidity qualification", () => {
  it("accepts the exact float-cap and amount boundaries", () => {
    expect(evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT,
      floatMarketCap: MIN_FLOAT_MARKET_CAP,
      turnoverRate: 3.2
    })).toEqual({ eligible: true, tags: [] });
  });

  it("rejects either hard metric below its boundary", () => {
    const lowCap = evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT,
      floatMarketCap: MIN_FLOAT_MARKET_CAP - 1,
      turnoverRate: 3.2
    });
    const lowAmount = evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT - 1,
      floatMarketCap: MIN_FLOAT_MARKET_CAP,
      turnoverRate: 3.2
    });

    expect(lowCap).toMatchObject({ eligible: false });
    expect(lowCap.tags).toContain("流通市值低于50亿元");
    expect(lowAmount).toMatchObject({ eligible: false });
    expect(lowAmount.tags).toContain("成交额低于2亿元");
  });

  it("rejects missing hard-gate data but keeps turnover display-only", () => {
    const missingCap = evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT,
      floatMarketCap: null,
      turnoverRate: 3.2
    });
    const missingTurnover = evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT,
      floatMarketCap: MIN_FLOAT_MARKET_CAP,
      turnoverRate: null
    });

    expect(missingCap).toMatchObject({ eligible: false });
    expect(missingCap.tags).toContain("流动性数据缺失");
    expect(missingTurnover).toMatchObject({ eligible: true });
    expect(missingTurnover.tags).toContain("流动性数据缺失");
  });

  it("marks abnormal turnover without using it as a hard gate", () => {
    const result = evaluateLiquidity({
      amount: MIN_DAILY_AMOUNT,
      floatMarketCap: MIN_FLOAT_MARKET_CAP,
      turnoverRate: ABNORMAL_TURNOVER_RATE
    });

    expect(result.eligible).toBe(true);
    expect(result.tags).toContain("换手率异常");
  });

  it("filters ineligible observation rows while retaining risk rows", () => {
    const observation = makeRow("000001", "trend-strength", {
      liquidityEligible: false,
      liquidityTags: ["流通市值低于50亿元"]
    });
    const risk = makeRow("000002", "risk-filter", {
      stance: "谨慎",
      liquidityEligible: false,
      liquidityTags: ["流动性数据缺失"]
    });
    const snapshot = assembleSnapshot(
      [observation, risk],
      "2026-07-09",
      "2026-07-09T15:00:00+08:00",
      "provider",
      "测试数据源"
    );

    expect(snapshot.topRows).toEqual([]);
    expect(snapshot.boards.find((board) => board.id === "trend-strength")?.rows).toEqual([]);
    expect(snapshot.boards.find((board) => board.id === "risk-filter")?.rows.map((row) => row.code)).toEqual(["000002"]);
  });

  it("sorts equal scores by float market cap, then stock code", () => {
    const rows = [
      makeRow("000003", "trend-strength", { floatMarketCap: MIN_FLOAT_MARKET_CAP }),
      makeRow("000002", "trend-strength", { floatMarketCap: MIN_FLOAT_MARKET_CAP + 1_000_000_000 }),
      makeRow("000001", "trend-strength", { floatMarketCap: MIN_FLOAT_MARKET_CAP + 1_000_000_000 }),
      makeRow("000004", "trend-strength", { floatMarketCap: null })
    ];
    expect(rows.sort(compareRows).map((row) => row.code)).toEqual(["000001", "000002", "000003", "000004"]);
  });

  it("persists the trigger close and normalized current-day liquidity metrics", () => {
    const snapshot = buildSnapshotFromStocks(
      [{
        code: "000001",
        name: "测试股票",
        industry: "测试行业",
        bars: makeBars(11, {
          amount: MIN_DAILY_AMOUNT,
          turnoverRate: 2.345,
          floatMarketCap: MIN_FLOAT_MARKET_CAP
        })
      }],
      new Date("2026-06-30T07:00:00.000Z"),
      "测试数据源"
    );
    const row = snapshot.boards.find((board) => board.id === "trend-strength")?.rows[0];

    expect(row).toMatchObject({
      triggerDate: "2026-06-30",
      triggerClose: 11,
      amount: MIN_DAILY_AMOUNT,
      turnoverRate: 2.35,
      floatMarketCap: MIN_FLOAT_MARKET_CAP,
      liquidityEligible: true,
      liquidityTags: []
    });
  });

  it("retains a generated risk row when liquidity metrics are missing", () => {
    const snapshot = buildSnapshotFromStocks(
      [{
        code: "000002",
        name: "风险测试",
        industry: "测试行业",
        bars: makeBars(8, {
          amount: MIN_DAILY_AMOUNT,
          turnoverRate: null,
          floatMarketCap: null,
          volume: 200
        })
      }],
      new Date("2026-06-30T07:00:00.000Z"),
      "测试数据源"
    );
    const row = snapshot.boards.find((board) => board.id === "risk-filter")?.rows[0];

    expect(row).toMatchObject({
      code: "000002",
      liquidityEligible: false,
      liquidityTags: ["流动性数据缺失"]
    });
  });

  it("conservatively migrates legacy persisted rows without letting them bypass the gate", () => {
    const current = assembleSnapshot(
      [
        makeRow("000001", "trend-strength"),
        makeRow("000002", "risk-filter", { stance: "谨慎" })
      ],
      "2026-07-09",
      "2026-07-09T15:00:00+08:00",
      "provider",
      "旧版测试"
    );
    const legacy = {
      ...current,
      boards: current.boards.map((board) => ({
        ...board,
        rows: board.rows.map(stripLiquidityFields)
      })),
      topRows: current.topRows.map(stripLiquidityFields)
    } as unknown as SignalSnapshot;

    const migrated = enforceSnapshotLiquidity(legacy);
    expect(migrated.topRows).toEqual([]);
    expect(migrated.boards.find((board) => board.id === "trend-strength")?.rows).toEqual([]);
    expect(migrated.boards.find((board) => board.id === "risk-filter")?.rows[0]).toMatchObject({
      code: "000002",
      liquidityEligible: false,
      liquidityTags: ["流动性数据缺失"]
    });
    expect(() => renderHtml(migrated)).not.toThrow();
    expect(renderHtml(migrated)).toContain("暂无数据");
  });
});

function stripLiquidityFields(row: SignalRow): Omit<SignalRow, "triggerClose" | "turnoverRate" | "floatMarketCap" | "liquidityEligible" | "liquidityTags"> {
  const {
    triggerClose: _triggerClose,
    turnoverRate: _turnoverRate,
    floatMarketCap: _floatMarketCap,
    liquidityEligible: _liquidityEligible,
    liquidityTags: _liquidityTags,
    ...legacy
  } = row;
  return legacy;
}

function makeRow(code: string, signalId: SignalId, overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    code,
    name: `测试${code}`,
    signalId,
    signalName: "测试信号",
    stance: signalId === "risk-filter" ? "谨慎" : "观察",
    triggerDate: "2026-07-09",
    triggerClose: 10,
    indicators: {
      kdj: { k: 20, d: 18, j: 24 },
      macd: { dif: 0.1, dea: 0.05, histogram: 0.05 },
      rsi: 35
    },
    amount: MIN_DAILY_AMOUNT,
    turnoverRate: 2,
    floatMarketCap: MIN_FLOAT_MARKET_CAP,
    liquidityEligible: true,
    liquidityTags: [],
    industry: "测试行业",
    change5d: 1,
    change20d: 2,
    riskTags: signalId === "risk-filter" ? ["跌破5日线", "低于10日线"] : ["信号待确认"],
    signalStrength: 88,
    ...overrides
  };
}

function makeBars(
  finalClose: number,
  finalMetrics: Pick<DailyBar, "amount" | "turnoverRate" | "floatMarketCap"> & { volume?: number }
): DailyBar[] {
  return Array.from({ length: 30 }, (_, index) => {
    const isFinal = index === 29;
    const close = isFinal ? finalClose : 10;
    return {
      date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: isFinal ? (finalMetrics.volume ?? 110) : 100,
      amount: isFinal ? finalMetrics.amount : 100_000_000,
      turnoverRate: isFinal ? finalMetrics.turnoverRate : 1,
      floatMarketCap: isFinal ? finalMetrics.floatMarketCap : MIN_FLOAT_MARKET_CAP
    };
  });
}
