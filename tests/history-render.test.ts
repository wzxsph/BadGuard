import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  HISTORY_INDEX_KEY,
  HISTORY_SNAPSHOT_PREFIX,
  type HistoryDetail,
  type SignalHistoryIndex
} from "../src/history";
import { renderHistoryHtml } from "../src/history-render";
import type { Env } from "../src/data-source";
import type { SignalRow, SignalSnapshot } from "../src/types";

describe("history page rendering", () => {
  it("renders dates, four accessible tabs, liquidity metrics and every return state", () => {
    const detail = makeDetail([
      makeRow("000001", { t1: complete(2.5), t2: complete(-1.25) }),
      makeRow("000002", { t1: complete(0), t2: pending() }),
      makeRow("000003", { t1: missing(), t2: pending() })
    ]);

    const html = renderHistoryHtml([
      { date: "2026-07-09", source: "live", status: "ready" },
      { date: "2026-07-08", source: "backfill", status: "ready" }
    ], detail);

    expect(html).toContain('href="/"');
    expect(html).toContain('href="/history" aria-current="page"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(html).toContain('event.key === "ArrowRight"');
    expect(html).toContain('event.key === "Home"');
    expect(html).toContain("低位反弹");
    expect(html).toContain("趋势转强");
    expect(html).toContain("超跌修复");
    expect(html).toContain("风险过滤");
    expect(html).toContain("流通市值");
    expect(html).toContain("换手率");
    expect(html).toContain("扫描股票");
    expect(html).toContain("行情成功");
    expect(html).toContain("精确收盘");
    expect(html).toContain("股票池来源");
    expect(html).toContain("股票池版本");
    expect(html).toContain("股票池沿用");
    expect(html).toContain("数量变化本身不代表数据故障");
    expect(html).toContain("+2.5%");
    expect(html).toContain("-1.25%");
    expect(html).toContain("待收盘");
    expect(html).toContain("暂无数据");
    expect(html).toContain("后续涨跌仅用于复盘，不代表策略胜率或交易建议");
    expect(html).toContain('href="https://github.com/wzxsph/BadGuard"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("@media (max-width: 760px)");
    expect(html.indexOf('data-history-date="2026-07-09"')).toBeLessThan(
      html.indexOf('data-history-date="2026-07-08"')
    );

    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    expect(() => new Function(scripts.at(-1)![1])).not.toThrow();
  });

  it("renders explicit empty and API-error states", () => {
    expect(renderHistoryHtml([], null)).toContain("暂无可用历史数据");
    const errorHtml = renderHistoryHtml([], null, "历史存储暂时不可用");
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("历史存储暂时不可用");
  });

  it("labels a temporary repository seed distinctly from a live retention", () => {
    const detail = makeDetail([makeRow("000001", { t1: pending(), t2: pending() })], true);
    const html = renderHistoryHtml([
      { date: "2026-07-09", source: "live", status: "ready", bootstrapSeed: true }
    ], detail);

    expect(html).toContain("临时恢复种子");
    expect(html).toContain("1/3 只");
    expect(html).toContain("价格表只保留榜内代码");
  });
});

describe("history worker routes", () => {
  it("returns 400 for an invalid date before reading KV", async () => {
    const get = vi.fn();
    const response = await worker.fetch(
      new Request("https://example.test/api/history/2026-02-30"),
      { SIGNAL_KV: { get } as unknown as KVNamespace }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_history_date" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns available dates and defaults the history page to the latest one", async () => {
    const snapshot = makeSnapshot([makeRow("000001", { t1: pending(), t2: pending() })]);
    const index: SignalHistoryIndex = {
      version: 1,
      tradingDates: ["2026-07-08", "2026-07-09"],
      entries: [
        { date: "2026-07-09", source: "live", status: "ready", bootstrapSeed: true },
        { date: "2026-07-08", source: "backfill", status: "ready" }
      ]
    };
    const values = new Map<string, unknown>([
      [HISTORY_INDEX_KEY, index],
      [`${HISTORY_SNAPSHOT_PREFIX}2026-07-09`, snapshot]
    ]);
    const env = kvEnv(values);

    const listResponse = await worker.fetch(new Request("https://example.test/api/history"), env);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      dates: [
        { date: "2026-07-09", source: "live", bootstrapSeed: true },
        { date: "2026-07-08", source: "backfill" }
      ]
    });

    const pageResponse = await worker.fetch(new Request("https://example.test/history"), env);
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    expect(html).toContain("2026-07-09 榜单");
    expect(html).toContain("临时恢复种子");

    const detailResponse = await worker.fetch(
      new Request("https://example.test/api/history/2026-07-09"),
      env
    );
    expect(await detailResponse.json()).toMatchObject({
      date: "2026-07-09",
      dataQuality: {
        kind: "bootstrap-seed",
        stockCount: 3,
        universeSource: "provider"
      }
    });
  });

  it("returns distinct 404 and 503 errors without reading latest-signal-snapshot", async () => {
    const index: SignalHistoryIndex = {
      version: 1,
      tradingDates: ["2026-07-08", "2026-07-09"],
      entries: [{ date: "2026-07-08", source: "backfill", status: "ready" }]
    };
    const { env, get } = trackedKvEnv(new Map([[HISTORY_INDEX_KEY, index]]));

    const missingResponse = await worker.fetch(
      new Request("https://example.test/api/history/2026-07-09"),
      env
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({ error: { code: "history_not_found" } });
    expect(get.mock.calls.flat()).not.toContain("latest-signal-snapshot");

    const unavailableResponse = await worker.fetch(
      new Request("https://example.test/api/history"),
      {}
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toMatchObject({ error: { code: "history_storage_unavailable" } });
  });

  it("returns 405 for history mutations", async () => {
    const response = await worker.fetch(new Request("https://example.test/api/history", { method: "POST" }), {});
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

function makeDetail(rows: SignalRow[], bootstrapSeed = false): HistoryDetail {
  const snapshot = makeSnapshot(rows);
  if (bootstrapSeed) {
    snapshot.meta.bootstrapSeed = true;
    snapshot.meta.bootstrapCloseCoverage = "ranked-codes-only";
    snapshot.meta.bootstrapPublishedCloseCount = new Set(rows.map((row) => row.code)).size;
  }
  const enrich = (row: SignalRow) => ({
    ...row,
    forwardReturns: (row as SignalRow & { forwardReturns: unknown }).forwardReturns
  });
  return {
    date: "2026-07-09",
    source: "live",
    entry: { date: "2026-07-09", source: "live", status: "ready", ...(bootstrapSeed ? { bootstrapSeed: true } : {}) },
    snapshot: {
      ...snapshot,
      boards: snapshot.boards.map((board) => ({ ...board, rows: board.rows.map(enrich) })),
      topRows: snapshot.topRows.map(enrich)
    }
  } as HistoryDetail;
}

function makeSnapshot(rows: SignalRow[]): SignalSnapshot {
  const boardIds = ["low-rebound", "trend-strength", "oversold-repair", "risk-filter"] as const;
  return {
    marketDate: "2026-07-09",
    refreshedAt: "2026-07-09T15:30:00+08:00",
    source: "provider",
    sourceLabel: "测试",
    meta: {
      scanLimit: 3,
      stockCount: 3,
      universeSource: "provider",
      historySource: "provider",
      failureCount: 0,
      buildMode: "local",
      historySuccessCount: 3,
      historySuccessRate: 1,
      exactCloseCount: 3,
      exactCloseCoverage: 1,
      perBoardLimit: 0,
      runContextHash: "0123456789abcdef0123456789abcdef"
    },
    boards: boardIds.map((id) => ({
      id,
      title: id,
      signalName: "测试信号",
      stance: id === "risk-filter" ? "谨慎" : "观察",
      summary: `${id} summary`,
      rows: id === "low-rebound" ? rows : []
    })),
    topRows: rows,
    philosophy: "测试",
    disclaimers: ["测试"]
  };
}

function makeRow(
  code: string,
  forwardReturns: { t1: unknown; t2: unknown }
): SignalRow {
  return {
    code,
    name: `测试${code}`,
    signalId: "low-rebound",
    signalName: "测试信号",
    stance: "观察",
    triggerDate: "2026-07-09",
    triggerClose: 10,
    indicators: {
      kdj: { k: 20, d: 18, j: 24 },
      macd: { dif: 0.1, dea: 0.05, histogram: 0.05 },
      rsi: 35
    },
    amount: 300_000_000,
    turnoverRate: 2.5,
    floatMarketCap: 10_000_000_000,
    liquidityEligible: true,
    liquidityTags: [],
    industry: "测试",
    change5d: 1,
    change20d: 2,
    riskTags: [],
    signalStrength: 80,
    forwardReturns
  } as SignalRow;
}

function complete(returnPct: number): unknown {
  return { status: "complete", tradingDate: "2026-07-10", close: 10, returnPct };
}

function pending(): unknown {
  return { status: "pending", tradingDate: "2026-07-10", close: null, returnPct: null, reason: "not-reached" };
}

function missing(): unknown {
  return { status: "missing", tradingDate: "2026-07-10", close: null, returnPct: null, reason: "stock-close" };
}

function kvEnv(values: Map<string, unknown>): Env {
  return trackedKvEnv(values).env;
}

function trackedKvEnv(values: Map<string, unknown>): { env: Env; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  return {
    env: { SIGNAL_KV: { get } as unknown as KVNamespace },
    get
  };
}
