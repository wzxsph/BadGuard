import type { BollValue, DailyBar, KdjValue, MacdValue } from "./types";

export interface IndicatorPoint {
  date: string;
  close: number;
  volume: number;
  amount: number;
  turnoverRate: number | null;
  floatMarketCap: number | null;
  kdj: KdjValue | null;
  macd: MacdValue | null;
  rsi: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  boll: BollValue | null;
  volumeRatio: number | null;
}

export function buildIndicatorSeries(bars: DailyBar[]): IndicatorPoint[] {
  const closes = bars.map((bar) => bar.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);
  const rsi6 = rsi(closes, 6);
  const kdjValues = kdj(bars, 9);

  return bars.map((bar, index) => {
    const ma5 = movingAverage(closes, index, 5);
    const ma10 = movingAverage(closes, index, 10);
    const ma20 = movingAverage(closes, index, 20);
    const boll = ma20 === null ? null : bollinger(closes, index, 20, ma20);

    return {
      date: bar.date,
      close: bar.close,
      volume: bar.volume,
      amount: bar.amount,
      turnoverRate: normalizeOptionalMetric(bar.turnoverRate),
      floatMarketCap: normalizeOptionalMetric(bar.floatMarketCap),
      kdj: kdjValues[index],
      macd: {
        dif: dif[index],
        dea: dea[index],
        histogram: dif[index] - dea[index]
      },
      rsi: rsi6[index],
      ma5,
      ma10,
      ma20,
      boll,
      volumeRatio: volumeRatio(bars, index, 5)
    };
  });
}

function normalizeOptionalMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function calculateReturn(bars: DailyBar[], lookback: number): number {
  const currentIndex = bars.length - 1;
  const previousIndex = currentIndex - lookback;

  if (previousIndex < 0) {
    return 0;
  }

  const previousClose = bars[previousIndex].close;
  const currentClose = bars[currentIndex].close;
  return ((currentClose - previousClose) / previousClose) * 100;
}

export function roundMetric(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function movingAverage(values: number[], index: number, period: number): number | null {
  if (index + 1 < period) {
    return null;
  }

  let total = 0;
  for (let offset = index - period + 1; offset <= index; offset += 1) {
    total += values[offset];
  }

  return total / period;
}

function bollinger(values: number[], index: number, period: number, middle: number): BollValue | null {
  if (index + 1 < period) {
    return null;
  }

  let variance = 0;
  for (let offset = index - period + 1; offset <= index; offset += 1) {
    variance += (values[offset] - middle) ** 2;
  }

  const std = Math.sqrt(variance / period);
  return {
    middle,
    upper: middle + 2 * std,
    lower: middle - 2 * std
  };
}

function ema(values: number[], period: number): number[] {
  const factor = 2 / (period + 1);
  const output: number[] = [];

  values.forEach((value, index) => {
    if (index === 0) {
      output.push(value);
      return;
    }

    output.push(value * factor + output[index - 1] * (1 - factor));
  });

  return output;
}

function rsi(values: number[], period: number): Array<number | null> {
  const output: Array<number | null> = Array(values.length).fill(null);

  if (values.length <= period) {
    return output;
  }

  let gainTotal = 0;
  let lossTotal = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gainTotal += Math.max(change, 0);
    lossTotal += Math.max(-change, 0);
  }

  let averageGain = gainTotal / period;
  let averageLoss = lossTotal / period;
  output[period] = toRsi(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = toRsi(averageGain, averageLoss);
  }

  return output;
}

function toRsi(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function kdj(bars: DailyBar[], period: number): Array<KdjValue | null> {
  const output: Array<KdjValue | null> = [];
  let previousK = 50;
  let previousD = 50;

  bars.forEach((bar, index) => {
    if (index + 1 < period) {
      output.push(null);
      return;
    }

    const window = bars.slice(index - period + 1, index + 1);
    const highest = Math.max(...window.map((item) => item.high));
    const lowest = Math.min(...window.map((item) => item.low));
    const rsv = highest === lowest ? 50 : ((bar.close - lowest) / (highest - lowest)) * 100;
    const k = (2 * previousK + rsv) / 3;
    const d = (2 * previousD + k) / 3;
    const j = 3 * k - 2 * d;

    previousK = k;
    previousD = d;
    output.push({ k, d, j });
  });

  return output;
}

function volumeRatio(bars: DailyBar[], index: number, period: number): number | null {
  if (index < period) {
    return null;
  }

  let total = 0;
  for (let offset = index - period; offset < index; offset += 1) {
    total += bars[offset].volume;
  }

  const average = total / period;
  return average === 0 ? null : bars[index].volume / average;
}
