import { DISCLAIMERS, PHILOSOPHY, SIGNAL_DEFINITIONS } from "./definitions";
import { buildIndicatorSeries, calculateReturn, roundMetric, type IndicatorPoint } from "./indicators";
import type { DailyBar, SignalBoard, SignalId, SignalRow, SignalSnapshot, StockSeries } from "./types";

const OBSERVATION_SIGNAL_IDS = new Set<SignalId>(["low-rebound", "trend-strength", "oversold-repair"]);

export function buildSnapshotFromStocks(
  stocks: StockSeries[],
  now = new Date(),
  sourceLabel = "行情数据源"
): SignalSnapshot {
  const rows: SignalRow[] = [];

  stocks.forEach((stock) => {
    const bars = normalizeBars(stock.bars);
    if (bars.length < 30) {
      return;
    }

    const points = buildIndicatorSeries(bars);
    const current = points[points.length - 1];
    const previous = points[points.length - 2];

    if (!hasRequiredIndicators(current) || !hasRequiredIndicators(previous)) {
      return;
    }

    const context = {
      stock,
      bars,
      current,
      previous,
      change5d: calculateReturn(bars, 5),
      change20d: calculateReturn(bars, 20)
    };

    if (isLowRebound(current, previous)) {
      rows.push(makeRow("low-rebound", context, scoreLowRebound(current, previous, context.change5d, context.change20d)));
    }

    if (isTrendStrength(current, previous)) {
      rows.push(makeRow("trend-strength", context, scoreTrendStrength(current, previous, context.change5d, context.change20d)));
    }

    if (isOversoldRepair(current, previous)) {
      rows.push(makeRow("oversold-repair", context, scoreOversoldRepair(current, previous, context.change5d, context.change20d)));
    }

    if (isRiskFilter(current, previous)) {
      rows.push(makeRow("risk-filter", context, scoreRisk(current, previous)));
    }
  });

  return assembleSnapshot(rows, formatChinaDate(now), now.toISOString(), "provider", sourceLabel);
}

export function assembleSnapshot(
  rows: SignalRow[],
  marketDate: string,
  refreshedAt: string,
  source: SignalSnapshot["source"],
  sourceLabel: string
): SignalSnapshot {
  const boards: SignalBoard[] = SIGNAL_DEFINITIONS.map((definition) => ({
    ...definition,
    rows: rows
      .filter((row) => row.signalId === definition.id)
      .sort((left, right) => right.signalStrength - left.signalStrength)
  }));

  const topRows = rows
    .filter((row) => OBSERVATION_SIGNAL_IDS.has(row.signalId))
    .sort((left, right) => right.signalStrength - left.signalStrength);

  return {
    marketDate,
    refreshedAt,
    source,
    sourceLabel,
    boards,
    topRows,
    philosophy: PHILOSOPHY,
    disclaimers: DISCLAIMERS
  };
}

export function formatChinaDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(date);
}

interface SignalContext {
  stock: StockSeries;
  bars: DailyBar[];
  current: RequiredPoint;
  previous: RequiredPoint;
  change5d: number;
  change20d: number;
}

type RequiredPoint = IndicatorPoint & {
  kdj: NonNullable<IndicatorPoint["kdj"]>;
  macd: NonNullable<IndicatorPoint["macd"]>;
  rsi: number;
  ma5: number;
  ma10: number;
  ma20: number;
  boll: NonNullable<IndicatorPoint["boll"]>;
  volumeRatio: number;
};

function normalizeBars(bars: DailyBar[]): DailyBar[] {
  return bars
    .filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.volume) && Number.isFinite(bar.amount))
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date));
}

function hasRequiredIndicators(point: IndicatorPoint): point is RequiredPoint {
  return Boolean(point.kdj && point.macd && point.rsi !== null && point.ma5 && point.ma10 && point.ma20 && point.boll && point.volumeRatio);
}

function isLowRebound(current: RequiredPoint, previous: RequiredPoint): boolean {
  const crossed = previous.kdj.k <= previous.kdj.d && current.kdj.k > current.kdj.d;
  const lowArea = Math.min(current.kdj.k, current.kdj.d) <= 28;
  return crossed && lowArea && current.volumeRatio >= 1.2;
}

function isTrendStrength(current: RequiredPoint, previous: RequiredPoint): boolean {
  const macdCrossed = previous.macd.dif <= previous.macd.dea && current.macd.dif > current.macd.dea;
  const backAboveAverages = current.close >= current.ma5 && current.close >= current.ma10;
  return macdCrossed && backAboveAverages;
}

function isOversoldRepair(current: RequiredPoint, previous: RequiredPoint): boolean {
  const rsiLifted = previous.rsi <= 38 && current.rsi > previous.rsi + 1.5;
  const reclaimedLowerBand = previous.close <= previous.boll.lower * 1.02 && current.close >= current.boll.lower;
  return rsiLifted && reclaimedLowerBand;
}

function isRiskFilter(current: RequiredPoint, previous: RequiredPoint): boolean {
  const riskItems = buildRiskTags(current, previous, true);
  return riskItems.length >= 2;
}

function makeRow(signalId: SignalId, context: SignalContext, strength: number): SignalRow {
  const definition = SIGNAL_DEFINITIONS.find((item) => item.id === signalId);
  if (!definition) {
    throw new Error(`Unknown signal id: ${signalId}`);
  }

  return {
    code: context.stock.code,
    name: context.stock.name,
    signalId,
    signalName: definition.signalName,
    stance: definition.stance,
    triggerDate: context.current.date,
    indicators: {
      kdj: {
        k: roundMetric(context.current.kdj.k),
        d: roundMetric(context.current.kdj.d),
        j: roundMetric(context.current.kdj.j)
      },
      macd: {
        dif: roundMetric(context.current.macd.dif),
        dea: roundMetric(context.current.macd.dea),
        histogram: roundMetric(context.current.macd.histogram)
      },
      rsi: roundMetric(context.current.rsi)
    },
    amount: roundMetric(context.current.amount, 0),
    industry: context.stock.industry,
    change5d: roundMetric(context.change5d),
    change20d: roundMetric(context.change20d),
    riskTags: signalId === "risk-filter" ? buildRiskTags(context.current, context.previous, true) : buildRiskTags(context.current, context.previous, false),
    signalStrength: Math.round(clamp(strength, 0, 100))
  };
}

function buildRiskTags(current: RequiredPoint, previous: RequiredPoint, strict: boolean): string[] {
  const tags: string[] = [];
  const brokeMa5 = previous.close >= previous.ma5 && current.close < current.ma5;
  const belowMa10 = current.close < current.ma10;
  const heavyDrop = current.close < previous.close * 0.985 && current.volumeRatio >= 1.25;
  const highDeathCross = previous.kdj.k >= previous.kdj.d && current.kdj.k < current.kdj.d && Math.max(previous.kdj.k, previous.kdj.d) >= 75;

  if (brokeMa5) {
    tags.push("跌破5日线");
  }

  if (belowMa10) {
    tags.push("低于10日线");
  }

  if (heavyDrop) {
    tags.push("放量下跌");
  }

  if (highDeathCross) {
    tags.push("KDJ高位死叉");
  }

  if (!strict) {
    if (current.close < current.ma20) {
      tags.push("仍在20日线下");
    }

    if (current.volumeRatio >= 1.8) {
      tags.push("量能波动放大");
    }

    if (tags.length === 0) {
      tags.push("信号待确认");
    }
  }

  return Array.from(new Set(tags));
}

function scoreLowRebound(current: RequiredPoint, previous: RequiredPoint, change5d: number, change20d: number): number {
  return scoreUpsidePriority("low-rebound", current, previous, change5d, change20d);
}

function scoreTrendStrength(current: RequiredPoint, previous: RequiredPoint, change5d: number, change20d: number): number {
  return scoreUpsidePriority("trend-strength", current, previous, change5d, change20d);
}

function scoreOversoldRepair(current: RequiredPoint, previous: RequiredPoint, change5d: number, change20d: number): number {
  return scoreUpsidePriority("oversold-repair", current, previous, change5d, change20d);
}

function scoreUpsidePriority(signalId: Exclude<SignalId, "risk-filter">, current: RequiredPoint, previous: RequiredPoint, change5d: number, change20d: number): number {
  const base = {
    "trend-strength": 62,
    "low-rebound": 46,
    "oversold-repair": 44
  }[signalId];

  let trendConfirmation = 0;
  if (current.close >= current.ma5) {
    trendConfirmation += 8;
  }
  if (current.close >= current.ma10) {
    trendConfirmation += 8;
  }
  if (current.close >= current.ma20) {
    trendConfirmation += 6;
  }
  if (current.ma5 >= current.ma10) {
    trendConfirmation += 5;
  }
  if (current.macd.dif > current.macd.dea) {
    trendConfirmation += 8;
  }
  if (current.macd.histogram > previous.macd.histogram) {
    trendConfirmation += 6;
  }
  if (current.kdj.k > current.kdj.d) {
    trendConfirmation += 4;
  }

  const volumeConfirmation = Math.min(12, Math.max(0, current.volumeRatio - 1) * 7);
  const recentConfirmation = clamp(change5d, -8, 12) * 1.2 + clamp(change20d, -15, 18) * 0.35;

  let signalQuality = 0;
  if (signalId === "trend-strength") {
    signalQuality += Math.max(0, current.macd.dif - current.macd.dea) * 140;
    signalQuality += ((current.close - Math.max(current.ma5, current.ma10)) / current.close) * 120;
  } else if (signalId === "low-rebound") {
    signalQuality += Math.max(0, 30 - Math.min(current.kdj.k, current.kdj.d)) * 0.45;
    signalQuality += Math.max(0, current.kdj.k - current.kdj.d) * 0.8;
  } else {
    signalQuality += (current.rsi - previous.rsi) * 1.2;
    signalQuality += ((current.close - current.boll.lower) / current.close) * 70;
    signalQuality += Math.max(0, 45 - current.rsi) * 0.25;
  }

  let riskPenalty = 0;
  if (current.close < current.ma10) {
    riskPenalty += 12;
  }
  if (current.close < current.ma20) {
    riskPenalty += 18;
  }
  if (current.close < previous.close * 0.985 && current.volumeRatio >= 1.25) {
    riskPenalty += 12;
  }
  if (previous.kdj.k >= previous.kdj.d && current.kdj.k < current.kdj.d) {
    riskPenalty += 10;
  }
  if (change5d < -5) {
    riskPenalty += 6;
  }
  if (current.rsi > 78) {
    riskPenalty += 6;
  }

  return base + trendConfirmation + volumeConfirmation + recentConfirmation + signalQuality - riskPenalty;
}

function scoreRisk(current: RequiredPoint, previous: RequiredPoint): number {
  const tags = buildRiskTags(current, previous, true);
  const drop = Math.max(0, (previous.close - current.close) / previous.close) * 220;
  const volumePenalty = Math.max(0, current.volumeRatio - 1) * 16;
  const highKdjBonus = Math.max(0, Math.max(previous.kdj.k, previous.kdj.d) - 70) * 0.8;
  return 48 + tags.length * 8 + drop + volumePenalty + highKdjBonus;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
