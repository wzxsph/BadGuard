import { describe, expect, it } from "vitest";
import latestSnapshot from "../data/latest.json";
import { renderHtml } from "../src/render";
import type { SignalSnapshot } from "../src/types";

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
});
