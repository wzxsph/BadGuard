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

  it("renders the paper-note tone with a separate professional annotation area", () => {
    const html = renderHtml(snapshot);

    expect(html).toContain("散户看盘小纸条");
    expect(html).toContain("专业注解 · 冷静区");
    expect(html).toContain("今天又来抄底啦");
    expect(html).toContain("仅用于个人学习");
    expect(html).not.toContain("每日技术信号榜");
  });

  it("renders a one-time entry notice with disclaimer and term notes", () => {
    const html = renderHtml(snapshot);

    expect(html).toContain("data-entry-notice");
    expect(html).toContain("免责声明与名词注解");
    expect(html).toContain("结构确认分");
    expect(html).toContain("风险强度");
    expect(html).toContain("data-entry-accept");
    expect(html).toContain("badguard-entry-notice-accepted-v1");
  });

  it("renders a name-only company directory before the boards", () => {
    const html = renderHtml(snapshot);
    const directoryMatch = html.match(/<div class="directory-list"[^>]*>([\s\S]*?)<\/div>/);
    expect(directoryMatch).not.toBeNull();

    const directoryLinks = [...directoryMatch![1].matchAll(/<a class="directory-link"[^>]*>(.*?)<\/a>/g)];
    const visibleNames = directoryLinks.map((match) => match[1]);
    const visibleLinkTags = directoryLinks.map((match) => match[0]);

    expect(html.indexOf('id="company-directory"')).toBeLessThan(html.indexOf('id="low-rebound"'));
    expect(html.indexOf('class="professional-notes"')).toBeLessThan(html.indexOf('id="company-directory"'));
    expect(visibleNames.length).toBeGreaterThan(0);
    expect(visibleNames.every((name) => !/\d{6}/.test(name))).toBe(true);
    expect(visibleLinkTags.slice(0, 30).every((tag) => !tag.includes(" hidden"))).toBe(true);

    if (visibleLinkTags.length > 30) {
      expect(visibleLinkTags.slice(30).every((tag) => tag.includes(" hidden"))).toBe(true);
      expect(html).toContain('aria-controls="company-directory-list"');
      expect(html).toContain(`再看 ${Math.min(30, visibleLinkTags.length - 30)} 个`);
    }
  });

  it("keeps risk-filter rows out of the upside summary", () => {
    expect(snapshot.topRows.every((row) => row.signalId !== "risk-filter")).toBe(true);
    expect(new Set(snapshot.topRows.map((row) => row.stance))).toEqual(new Set(["观察"]));
  });

  it("shows only five cards per list before progressive expansion", () => {
    const html = renderHtml(snapshot);
    const boardWithMoreRows = snapshot.boards.find((board) => board.rows.length > 5);
    expect(boardWithMoreRows).toBeTruthy();

    const sectionStart = html.indexOf(`<section class="section section--board" id="${boardWithMoreRows!.id}">`);
    const nextBoardStart = html.indexOf('<section class="section section--board"', sectionStart + 1);
    const summaryStart = html.indexOf('<section class="section section--summary"', sectionStart + 1);
    const sectionEnd = [nextBoardStart, summaryStart].filter((index) => index > sectionStart).sort((left, right) => left - right)[0];
    const sectionHtml = html.slice(sectionStart, sectionEnd);

    const cardTags = [...sectionHtml.matchAll(/<article class="signal-card"[^>]*>/g)].map((match) => match[0]);

    expect(cardTags).toHaveLength(boardWithMoreRows!.rows.length);
    expect(cardTags.slice(0, 5).every((tag) => !tag.includes(" hidden"))).toBe(true);
    expect(cardTags.slice(5).every((tag) => tag.includes(" hidden"))).toBe(true);
    expect(sectionHtml).toContain("【展示更多】");
    expect(sectionHtml).toContain("data-progress-more");
  });

  it("groups card metrics into the requested two rows", () => {
    const html = renderHtml(snapshot);
    const cardMatch = html.match(/<article class="signal-card"[^>]*>([\s\S]*?)<\/article>/);
    expect(cardMatch).not.toBeNull();

    expect(cardMatch![1]).toMatch(/<div class="metric-pair metric-pair--date-return">[\s\S]*<dt>触发日期<\/dt>[\s\S]*<dt>近5\/20日<\/dt>/);
    expect(cardMatch![1]).toMatch(/<div class="metric-pair metric-pair--amount-industry">[\s\S]*<dt>成交额<\/dt>[\s\S]*<dt>所属行业<\/dt>/);
  });

  it("only uses observation-oriented stances in visible rows", () => {
    const stances = snapshot.boards.flatMap((board) => board.rows.map((row) => row.stance));

    expect(new Set(stances)).toEqual(new Set(["观察", "谨慎"]));
    expect(renderHtml(snapshot)).not.toContain("买入");
    expect(renderHtml(snapshot)).not.toContain("卖出");
  });

  it("keeps technical indicator values inside the detail area", () => {
    const html = renderHtml(snapshot);
    const cardMatch = html.match(/<article class="signal-card"[^>]*>([\s\S]*?)<\/article>/);
    expect(cardMatch).not.toBeNull();

    const [mainArea, detailArea] = cardMatch![1].split('<details class="signal-detail">');

    expect(mainArea).not.toContain("DIF");
    expect(mainArea).not.toContain("RSI");
    expect(mainArea).not.toMatch(/K\s+\d/);
    expect(detailArea).toContain("KDJ");
    expect(detailArea).toContain("MACD");
    expect(detailArea).toContain("RSI");
    expect(detailArea).toContain("公司概况 F10 小抄");
    expect(detailArea).toContain("主营业务");
    expect(detailArea).toContain("经营范围");
    expect(detailArea).not.toContain("<dt>公司</dt>");
    expect(detailArea).not.toContain("<dt>行业</dt>");
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

  it("uses the history index as the publication pointer without regressing a newer legacy latest", async () => {
    const latest = assembleSnapshot(
      [makeTestRow("000001", 80)],
      "2026-07-10",
      "2026-07-10T15:30:00+08:00",
      "provider",
      "legacy latest"
    );
    const indexedSameDate = assembleSnapshot(
      [makeTestRow("000001", 95)],
      "2026-07-10",
      "2026-07-10T15:31:00+08:00",
      "provider",
      "indexed revision"
    );
    const pointerKey = "history-snapshot:2026-07-10:v:0123456789abcdef";
    const values = new Map<string, unknown>([
      [LATEST_SIGNAL_SNAPSHOT_KEY, latest],
      ["signal-history-index", {
        version: 1,
        entries: [{
          date: "2026-07-10",
          source: "live",
          status: "ready",
          snapshotKey: pointerKey
        }]
      }],
      [pointerKey, indexedSameDate]
    ]);
    const result = await getSnapshot({
      SIGNAL_KV: {
        get: async (key: string) => values.get(key) ?? null
      } as unknown as KVNamespace
    });

    expect(result.sourceLabel).toBe("indexed revision");
    expect(result.topRows[0].signalStrength).toBe(95);

    values.set(LATEST_SIGNAL_SNAPSHOT_KEY, { ...latest, marketDate: "2026-07-11", sourceLabel: "newer legacy latest" });
    const newerLegacy = await getSnapshot({
      SIGNAL_KV: {
        get: async (key: string) => values.get(key) ?? null
      } as unknown as KVNamespace
    });
    expect(newerLegacy.marketDate).toBe("2026-07-11");
    expect(newerLegacy.sourceLabel).toBe("newer legacy latest");
  });

  it("keeps README public-safe and points at the native SVG preview", () => {
    const readme = fs.readFileSync("README.md", "utf8");

    expect(readme).toContain("docs/preview.svg");
    expect(readme).toContain("docs/experience-overview.svg");
    expect(readme).toContain("docs/experience-card-detail.svg");
    expect(readme).toContain("docs/experience-mobile-progressive.svg");
    expect(readme).toContain("【更多项目效果图】");
    expect(readme).not.toContain("点开像翻 PPT 一样横向看");
    expect(readme).toContain("<details>");
    expect(readme).not.toContain("docs/preview.png");
    expect(readme).not.toMatch(/c150f9|b1aa994|f20d697/);
    expect(readme.indexOf("## 页面展示什么")).toBeLessThan(readme.indexOf("## 专业注解"));
    expect(readme.indexOf("## 设计哲学")).toBeLessThan(readme.indexOf("## 专业注解"));
  });

  it("keeps experience diagrams free of concrete stock names and codes", () => {
    const diagramText = [
      "docs/experience-overview.svg",
      "docs/experience-card-detail.svg",
      "docs/experience-mobile-progressive.svg"
    ].map((path) => fs.readFileSync(path, "utf8")).join("\n");
    const snapshotNames = new Set(snapshot.boards.flatMap((board) => board.rows.map((row) => row.name)));

    expect(diagramText).not.toMatch(/\d{6}/);
    for (const name of snapshotNames) {
      expect(diagramText).not.toContain(name);
    }
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
    triggerClose: 10,
    indicators: {
      kdj: { k: 20, d: 18, j: 24 },
      macd: { dif: 0.1, dea: 0.05, histogram: 0.05 },
      rsi: 35
    },
    amount: 300000000,
    turnoverRate: 2,
    floatMarketCap: 5000000000,
    liquidityEligible: true,
    liquidityTags: [],
    industry: "测试行业",
    change5d: 1,
    change20d: 2,
    riskTags: ["信号待确认"],
    signalStrength
  };
}
