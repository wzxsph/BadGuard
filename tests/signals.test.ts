import { describe, expect, it } from "vitest";
import fs from "node:fs";
import latestSnapshot from "../data/latest.json";
import { getSnapshot, LATEST_SIGNAL_SNAPSHOT_KEY, STAGING_SIGNAL_SNAPSHOT_KEY } from "../src/data-source";
import { renderHtml } from "../src/render";
import { assembleSnapshot } from "../src/signals";
import type { SignalRow, SignalSnapshot } from "../src/types";

const snapshot = latestSnapshot as SignalSnapshot;

describe("daily technical signal board", () => {
  it("contains exactly the four fixed boards", () => {
    expect(snapshot.boards.map((board) => board.id)).toEqual([
      "low-rebound",
      "trend-strength",
      "oversold-repair",
      "risk-filter"
    ]);
  });

  it("sorts the homepage rows by signal strength", () => {
    const strengths = snapshot.topRows.map((row) => row.signalStrength);
    const sorted = strengths.slice().sort((left, right) => right - left);

    expect(strengths).toEqual(sorted);
  });

  it("uses stock code as a stable tie-breaker for equal strength rows", () => {
    const rows = [
      makeTestRow("000003", 88),
      makeTestRow("000001", 88),
      makeTestRow("000002", 88)
    ];

    const tiedSnapshot = assembleSnapshot(rows, "2026-07-09", "2026-07-09T15:00:00+08:00", "provider", "测试数据源", {
      scanLimit: 3,
      stockCount: 3,
      universeSource: "provider",
      historySource: "provider",
      failureCount: 0,
      buildMode: "local"
    });

    expect(tiedSnapshot.topRows.map((row) => row.code)).toEqual(["000001", "000002", "000003"]);
    expect(tiedSnapshot.boards[0].rows.map((row) => row.code)).toEqual(["000001", "000002", "000003"]);
  });

  it("includes snapshot metadata for data range transparency", () => {
    expect(snapshot.meta).toMatchObject({
      scanLimit: expect.any(Number),
      stockCount: expect.any(Number),
      universeSource: expect.any(String),
      historySource: expect.any(String),
      failureCount: expect.any(Number),
      buildMode: expect.any(String)
    });

    expect(renderHtml(snapshot)).toContain("数据范围");
  });

  it("keeps risk-filter rows out of the upside summary", () => {
    expect(snapshot.topRows.every((row) => row.signalId !== "risk-filter")).toBe(true);
    expect(new Set(snapshot.topRows.map((row) => row.stance))).toEqual(new Set(["观察"]));
  });

  it("only uses observation-oriented stances in visible rows", () => {
    const stances = snapshot.boards.flatMap((board) => board.rows.map((row) => row.stance));

    expect(new Set(stances)).toEqual(new Set(["观察", "谨慎"]));
    expect(renderHtml(snapshot)).not.toContain("买入");
    expect(renderHtml(snapshot)).not.toContain("卖出");
  });

  it("keeps technical indicator values inside the detail area", () => {
    const html = renderHtml(snapshot);
    const cardMatch = html.match(/<article class="signal-card">([\s\S]*?)<\/article>/);
    expect(cardMatch).not.toBeNull();

    const [mainArea, detailArea] = cardMatch![1].split('<details class="signal-detail">');

    expect(mainArea).not.toContain("DIF");
    expect(mainArea).not.toContain("RSI");
    expect(mainArea).not.toMatch(/K\s+\d/);
    expect(detailArea).toContain("KDJ");
    expect(detailArea).toContain("MACD");
    expect(detailArea).toContain("RSI");
  });

  it("renders the daily summary after all four boards", () => {
    const html = renderHtml(snapshot);

    expect(html.indexOf('id="risk-filter"')).toBeGreaterThan(html.indexOf('id="oversold-repair"'));
    expect(html.indexOf('id="daily-summary"')).toBeGreaterThan(html.indexOf('id="risk-filter"'));
  });

  it("reads production snapshot instead of staging snapshot", async () => {
    const productionSnapshot = { ...snapshot, marketDate: "2026-07-09" };
    const stagingSnapshot = { ...snapshot, marketDate: "2099-01-01" };
    const values = new Map<string, SignalSnapshot>([
      [LATEST_SIGNAL_SNAPSHOT_KEY, productionSnapshot],
      [STAGING_SIGNAL_SNAPSHOT_KEY, stagingSnapshot]
    ]);

    const result = await getSnapshot({
      SIGNAL_KV: {
        get: async (key: string) => values.get(key) ?? null
      } as unknown as KVNamespace
    });

    expect(result.marketDate).toBe("2026-07-09");
  });

  it("keeps README public-safe and points at the native SVG preview", () => {
    const readme = fs.readFileSync("README.md", "utf8");

    expect(readme).toContain("docs/preview.svg");
    expect(readme).not.toContain("docs/preview.png");
    expect(readme).not.toMatch(/c150f9|b1aa994|f20d697/);
  });
});

function makeTestRow(code: string, signalStrength: number): SignalRow {
  return {
    code,
    name: `测试${code}`,
    signalId: "low-rebound",
    signalName: "日线KDJ低位金叉 + 成交量放大",
    stance: "观察",
    triggerDate: "2026-07-09",
    indicators: {
      kdj: { k: 20, d: 18, j: 24 },
      macd: { dif: 0.1, dea: 0.05, histogram: 0.05 },
      rsi: 35
    },
    amount: 100000000,
    industry: "测试行业",
    change5d: 1,
    change20d: 2,
    riskTags: ["信号待确认"],
    signalStrength
  };
}
